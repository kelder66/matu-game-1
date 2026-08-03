import {
  Color,
  DirectionalLight,
  FogExp2,
  GridHelper,
  HemisphereLight,
  Intersection,
  MathUtils,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { TilesRenderer, WGS84_ELLIPSOID, ENU_FRAME } from '3d-tiles-renderer';
import {
  GoogleCloudAuthPlugin,
  TileCompressionPlugin,
  UnloadTilesPlugin,
  TilesFadePlugin,
  GLTFExtensionsPlugin,
} from '3d-tiles-renderer/plugins';
import type { FlightState } from '../shared/flight';
import { cameraTransform, elevationAt, horizonDistance, surfaceNormal } from './geo';

const EARTH_R = 6378137;

export interface World3D {
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  tiles: TilesRenderer | null;
  /** Metres above the ellipsoid of the terrain directly below the player. */
  groundAlt: number;
  update(state: FlightState, dt: number): void;
  attributions(): string;
  resize(): void;
  /** Teleport the chase camera into place instead of easing -- use on (re)spawn. */
  snapCamera(): void;
}

/** Phones have a fraction of the fill rate and bandwidth of a laptop. */
const isMobile = () => window.matchMedia('(hover: none) and (pointer: coarse)').matches;

export function createWorld(canvas: HTMLCanvasElement, apiKey: string | null): World3D {
  const mobile = isMobile();

  const renderer = new WebGLRenderer({
    canvas,
    // Antialiasing is the single most expensive flag on a mobile GPU, and at phone
    // pixel densities the jaggies barely show.
    antialias: !mobile,
    // far/near reaches ~26,000 at altitude; without this the depth buffer collapses.
    logarithmicDepthBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobile ? 1.5 : 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new Scene();
  scene.background = new Color(0x9fc4e8);

  const camera = new PerspectiveCamera(65, window.innerWidth / window.innerHeight, 5, 2e7);

  scene.add(new HemisphereLight(0xdfefff, 0x30402a, 1.6));
  const sun = new DirectionalLight(0xffffff, 1.4);
  sun.position.set(0.4, 0.6, 1).normalize();
  scene.add(sun);

  let tiles: TilesRenderer | null = null;
  let fallback: FallbackWorld | null = null;

  if (apiKey) {
    tiles = createTiles(apiKey, camera, renderer, mobile);
    scene.add(tiles.group);
  } else {
    fallback = createFallbackWorld(scene);
  }

  // Chase camera scratch.
  const camPos = new Vector3();
  const camQuat = new Quaternion();
  const back = new Vector3();
  const up = new Vector3();

  // Terrain probe scratch.
  const raycaster = new Raycaster();
  const probeUp = new Vector3();
  const probeOrigin = new Vector3();
  let probeAccum = 0;
  let groundTarget = 0;
  let snap = true; // first frame: place the camera, don't ease into it

  const world: World3D = {
    scene,
    camera,
    renderer,
    tiles,
    groundAlt: 0,

    update(state, dt) {
      updateChaseCam(camera, state, snap ? Infinity : dt, camPos, camQuat, back, up);
      snap = false;
      updateClip(camera, state);
      camera.updateMatrixWorld();

      if (tiles) {
        probeAccum += dt;
        if (probeAccum > 0.2) {
          probeAccum = 0;
          probeTerrain(tiles, state, raycaster, probeUp, probeOrigin, (alt) => {
            groundTarget = alt;
          });
        }
        // Ease toward the sample so a cliff edge doesn't make the floor stutter.
        world.groundAlt += (groundTarget - world.groundAlt) * (1 - Math.exp(-3 * dt));
        // Stop streaming while the tab is hidden -- saves CPU, bandwidth and battery.
        if (!document.hidden) tiles.update();
      } else if (fallback) {
        fallback.update(state);
      }

      renderer.render(scene, camera);
    },

    attributions() {
      if (!tiles) return '';
      const list = tiles.getAttributions();
      return list.length ? String(list[0].value) : '';
    },

    snapCamera() {
      snap = true;
    },

    resize() {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      if (tiles) tiles.setResolutionFromRenderer(camera, renderer);
    },
  };

  return world;
}

// --- Google Photorealistic 3D Tiles ---

function createTiles(
  apiKey: string,
  camera: PerspectiveCamera,
  renderer: WebGLRenderer,
  mobile: boolean,
): TilesRenderer {
  const tiles = new TilesRenderer();

  tiles.registerPlugin(
    // The session token expires; without autoRefresh a long session starts 401-ing.
    new GoogleCloudAuthPlugin({ apiToken: apiKey, autoRefreshToken: true }),
  );
  tiles.registerPlugin(new TileCompressionPlugin());
  tiles.registerPlugin(new UnloadTilesPlugin());
  tiles.registerPlugin(new TilesFadePlugin());
  tiles.registerPlugin(
    // three r185's DRACOLoader resolves its decoder with `new URL(..., import.meta.url)`,
    // so Vite bundles and fingerprints it automatically -- no CDN, no decoderPath to get
    // wrong in production, and it can never skew from the installed three version.
    new GLTFExtensionsPlugin({ dracoLoader: new DRACOLoader() }),
  );

  // NOTE: tiles.group is deliberately NOT rotated. World space stays ECEF so that
  // every getObjectFrame result drops straight in.

  // errorTarget is screen-space error in PIXELS: keep refining a tile until its
  // geometric error projects to fewer than this many pixels. At 820 m and 65 deg FOV,
  // 28 px accepts ~27 m of geometric error -- coarser than a whole building, which is
  // why cities looked like a texture painted on a hill. 12 px accepts ~12 m, which is
  // where roofs and towers actually appear, and still ~21 m at our 12 km ceiling.
  //
  // Google bills Photorealistic 3D Tiles per ROOT TILESET REQUEST -- one charge per
  // ~3 h session, NOT per tile. Lowering this costs bandwidth and VRAM, not money.
  // On a phone the same 12 means several times the geometry per screen pixel, on a
  // GPU and a mobile connection that cannot feed it -- hence the softer target.
  tiles.errorTarget = mobile ? 22 : 12; // raise if a weaker GPU struggles
  tiles.downloadQueue.maxJobs = mobile ? 10 : 18; // Google suggests 18; library default 25
  tiles.parseQueue.maxJobs = mobile ? 3 : 5; // library default 5 -- DRACO decode is the bottleneck
  // 400 MB is exactly the library default, so the old line here did nothing. A bigger
  // cache is what stops the same street re-downloading every time we circle back;
  // on a phone that much texture memory is a crash risk instead.
  tiles.lruCache.maxBytesSize = (mobile ? 250 : 800) * 1024 * 1024;

  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);
  return tiles;
}

// TilesRenderer.raycast and Raycaster.firstHitOnly both exist at runtime but are
// missing from the shipped type definitions.
type Raycastable = { raycast(raycaster: Raycaster, intersects: Intersection[]): void };
type FirstHitRaycaster = Raycaster & { firstHitOnly?: boolean };

function probeTerrain(
  tiles: TilesRenderer,
  state: FlightState,
  raycaster: Raycaster,
  up: Vector3,
  origin: Vector3,
  onHit: (alt: number) => void,
) {
  surfaceNormal(state.lat, state.lon, up);
  // Start 200 m above the plane and shoot straight down.
  origin.copy(up).multiplyScalar(EARTH_R + state.alt + 200);
  raycaster.set(origin, up.clone().negate());
  raycaster.far = 20000;
  (raycaster as FirstHitRaycaster).firstHitOnly = true;

  const hits: Intersection[] = [];
  (tiles as unknown as Raycastable).raycast(raycaster, hits);
  if (hits.length) onHit(elevationAt(hits[0].point));
}

// --- Chase camera ---

const CAM_BACK = 55;
const CAM_UP = 14;
const CAM_ROLL_MIX = 0.35; // a hinted tilt, not a spinning horizon
const CAM_LAG = 7;

function updateChaseCam(
  camera: PerspectiveCamera,
  s: FlightState,
  dt: number,
  camPos: Vector3,
  camQuat: Quaternion,
  back: Vector3,
  up: Vector3,
) {
  cameraTransform(
    s.lat,
    s.lon,
    s.alt,
    s.heading,
    s.pitch * 0.6,
    s.roll * CAM_ROLL_MIX,
    camPos,
    camQuat,
  );

  // CAMERA_FRAME looks down -Z, so +Z is behind the aircraft.
  back.set(0, 0, 1).applyQuaternion(camQuat);
  up.set(0, 1, 0).applyQuaternion(camQuat);
  camPos.addScaledVector(back, CAM_BACK).addScaledVector(up, CAM_UP);

  const a = 1 - Math.exp(-CAM_LAG * dt); // frame-rate independent smoothing
  camera.position.lerp(camPos, a);
  camera.quaternion.slerp(camQuat, a);
}

function updateClip(camera: PerspectiveCamera, s: FlightState) {
  camera.near = MathUtils.clamp(s.alt * 0.01, 1, 15);
  camera.far = horizonDistance(s.lat, s.alt) + 30000;
  camera.updateProjectionMatrix();
}

// --- Keyless fallback so the game runs with no API key ---

interface FallbackWorld {
  update(s: FlightState): void;
}

function createFallbackWorld(scene: Scene): FallbackWorld {
  scene.fog = new FogExp2(0x9fc4e8, 0.00004);

  // Must be an ELLIPSOID, not a sphere of the equatorial radius: WGS84 is ~21 km
  // flatter at the poles, so a plain sphere would swallow the plane whole at
  // Tallinn's latitude. Unit sphere, rotated Y-up -> Z-up, then scaled to the radii.
  const geo = new SphereGeometry(1, 96, 64);
  geo.rotateX(Math.PI / 2);
  const globe = new Mesh(geo, new MeshLambertMaterial({ color: 0x3b6b3a }));
  const rad = WGS84_ELLIPSOID.radius;
  globe.scale.set(rad.x, rad.y, rad.z);
  scene.add(globe);

  // A bare sphere looks static. The grid is what makes speed and altitude legible.
  const grid = new GridHelper(40000, 100, 0xffffff, 0xdff0d8);
  const gridMat = grid.material as { opacity: number; transparent: boolean };
  gridMat.transparent = true;
  gridMat.opacity = 0.55;
  scene.add(grid);

  const m = new Matrix4();
  const scale = new Vector3();
  let sinceAnchor = 1e9;

  return {
    update(s) {
      // Re-anchor under the player every ~5 s rather than every frame.
      sinceAnchor += 1;
      if (sinceAnchor > 300) {
        sinceAnchor = 0;
        // 5 m above the surface so it doesn't z-fight with the globe.
        WGS84_ELLIPSOID.getObjectFrame(s.lat, s.lon, 5, 0, 0, 0, m, ENU_FRAME);
        m.decompose(grid.position, grid.quaternion, scale);
        // GridHelper lies in the XZ plane; ENU_FRAME is Z-up, so stand it up.
        grid.rotateX(Math.PI / 2);
      }
    },
  };
}
