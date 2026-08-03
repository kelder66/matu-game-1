import {
  BoxGeometry,
  ConeGeometry,
  Color,
  Group,
  Mesh,
  MeshLambertMaterial,
} from 'three';

/**
 * A plane out of primitives: no asset pipeline, no loader, nothing to 404 on
 * Railway -- and the shape can be changed by editing three numbers.
 * Built at the origin with +Z forward and +Y up to match OBJECT_FRAME.
 */
export function buildPlane(color: number): Group {
  const g = new Group();

  const body = new MeshLambertMaterial({ color });
  const wingColor = new Color(color).lerp(new Color(0xffffff), 0.45).getHex();
  const wing = new MeshLambertMaterial({ color: wingColor });

  // Fuselage
  const fuselage = new Mesh(new BoxGeometry(2.2, 2.2, 12), body);
  g.add(fuselage);

  // Nose cone, pointing +Z
  const nose = new Mesh(new ConeGeometry(1.1, 4, 12), body);
  nose.rotation.x = Math.PI / 2;
  nose.position.z = 8;
  g.add(nose);

  // Main wing
  const mainWing = new Mesh(new BoxGeometry(18, 0.5, 3.2), wing);
  mainWing.position.z = 0.5;
  g.add(mainWing);

  // Horizontal stabiliser
  const tailWing = new Mesh(new BoxGeometry(7, 0.4, 1.8), wing);
  tailWing.position.z = -5.4;
  g.add(tailWing);

  // Vertical fin
  const fin = new Mesh(new BoxGeometry(0.4, 3, 2.4), wing);
  fin.position.set(0, 1.6, -5.4);
  g.add(fin);

  return g;
}

/** Where tracers come out of, in plane-local coordinates. */
export const MUZZLE_OFFSET = { x: 0, y: -0.6, z: 9 };
