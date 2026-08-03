// 3d-tiles-renderer 0.5.0 exports these at runtime (src/three/renderer/math/Ellipsoid.js)
// but its root index.d.ts only re-exports the Ellipsoid class, so TypeScript can't see
// them. Augment the module rather than hardcoding the numeric values.
//
// The `export {}` matters: without it this file is a global script and `declare module`
// would *replace* the package's types instead of adding to them.
export {};

declare module '3d-tiles-renderer' {
  export const ENU_FRAME: number;
  export const CAMERA_FRAME: number;
  export const OBJECT_FRAME: number;
}
