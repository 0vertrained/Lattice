#pragma once
#include <cmath>
#include <stdexcept>

namespace lattice {
// Ground rover policy is independent of Nav2's configured goal tolerance.
struct RouteRegion {
  double x, y, z, radius;
  void validate() const {
    if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(z) ||
        !std::isfinite(radius) || std::abs(x) > 10000 ||
        std::abs(y) > 10000 || std::abs(z) > 0.05 ||
        radius < 0.05 || radius > 2)
      throw std::runtime_error("invalid ground rover route region");
  }
  bool contains(double px, double py) const {
    return std::isfinite(px) && std::isfinite(py) &&
           std::hypot(std::hypot(px - x, py - y), z) <= radius;
  }
};
} // namespace lattice
