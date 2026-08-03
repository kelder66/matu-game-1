import { Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import { WGS84_ELLIPSOID, OBJECT_FRAME, CAMERA_FRAME } from '3d-tiles-renderer';
import type { FlightState } from '../shared/flight';

// World space is ECEF (Z-up), exactly what the ellipsoid math produces. The tiles
// group is deliberately left at identity so no transform has to be undone.

const _m = new Matrix4();
const _scale = new Vector3();

/** Place a mesh at a geodetic pose. OBJECT_FRAME is +Y up, +Z forward. */
export function applyPose(obj: Object3D, s: FlightState) {
  WGS84_ELLIPSOID.getObjectFrame(
    s.lat,
    s.lon,
    s.alt,
    s.heading,
    s.pitch,
    s.roll,
    _m,
    OBJECT_FRAME,
  );
  _m.decompose(obj.position, obj.quaternion, _scale);
  obj.scale.setScalar(1);
}

/** Decompose a geodetic pose into position + quaternion without touching an Object3D. */
export function poseToTransform(
  lat: number,
  lon: number,
  alt: number,
  hdg: number,
  pit: number,
  rol: number,
  outPos: Vector3,
  outQuat: Quaternion,
) {
  WGS84_ELLIPSOID.getObjectFrame(lat, lon, alt, hdg, pit, rol, _m, OBJECT_FRAME);
  _m.decompose(outPos, outQuat, _scale);
}

/** Camera pose for the same geodetic state. CAMERA_FRAME is +Y up, -Z forward. */
export function cameraTransform(
  lat: number,
  lon: number,
  alt: number,
  hdg: number,
  pit: number,
  rol: number,
  outPos: Vector3,
  outQuat: Quaternion,
) {
  WGS84_ELLIPSOID.getObjectFrame(lat, lon, alt, hdg, pit, rol, _m, CAMERA_FRAME);
  _m.decompose(outPos, outQuat, _scale);
}

export function surfaceNormal(lat: number, lon: number, out: Vector3): Vector3 {
  return WGS84_ELLIPSOID.getCartographicToNormal(lat, lon, out);
}

export function horizonDistance(lat: number, alt: number): number {
  return WGS84_ELLIPSOID.calculateHorizonDistance(lat, alt);
}

export function elevationAt(point: Vector3): number {
  return WGS84_ELLIPSOID.getPositionElevation(point);
}
