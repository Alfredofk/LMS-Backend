// The distance between two points on the Earth, in metres (teaching-and-learning
// 03: a check-in against the school's point).
//
// Haversine on a sphere of the Earth's mean radius. Off by at most about 0.5%
// against the ellipsoid, which at a 150 m radius is under a metre - far below
// what a phone's location is good for. No library: this is the whole of it.

const EARTH_RADIUS_M = 6_371_008.8;

const radians = (degrees) => (degrees * Math.PI) / 180;

function distanceMeters(a, b) {
    const dLat = radians(b.latitude - a.latitude);
    const dLng = radians(b.longitude - a.longitude);
    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export { distanceMeters };
