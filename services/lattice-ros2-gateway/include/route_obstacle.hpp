#pragma once
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <optional>
#include <vector>

namespace lattice {
struct CorridorBlockage {
  double distance_m;
  std::size_t samples;
};

// Conservative semantic-corridor observation, not a replacement for Nav2's
// collision planner. Only actual finite returns ahead of this route count.
inline std::optional<CorridorBlockage> corridor_blockage(
    double base_x, double base_y, double target_x, double target_y,
    double sensor_x, double sensor_y, double sensor_yaw, double angle_min,
    double angle_increment, double range_min, double range_max,
    const std::vector<float> &ranges) {
  const double distance = std::hypot(target_x - base_x, target_y - base_y);
  if (!std::isfinite(distance) || distance < 0.25 || ranges.empty() ||
      ranges.size() > 1080 || !std::isfinite(angle_min) ||
      !std::isfinite(angle_increment) || angle_increment <= 0 ||
      !std::isfinite(sensor_x) || !std::isfinite(sensor_y) ||
      !std::isfinite(sensor_yaw) || !std::isfinite(range_min) ||
      !std::isfinite(range_max) || range_min <= 0 || range_max <= range_min)
    return std::nullopt;
  const double ux = (target_x - base_x) / distance;
  const double uy = (target_y - base_y) / distance;
  double nearest = std::numeric_limits<double>::infinity();
  std::size_t hits = 0;
  for (std::size_t index = 0; index < ranges.size(); ++index) {
    const double range = ranges[index];
    if (!std::isfinite(range) || range < range_min || range > range_max)
      continue;
    const double angle = sensor_yaw + angle_min + index * angle_increment;
    const double dx = sensor_x + range * std::cos(angle) - base_x;
    const double dy = sensor_y + range * std::sin(angle) - base_y;
    const double ahead = dx * ux + dy * uy;
    const double lateral = std::abs(dx * uy - dy * ux);
    if (ahead >= 0.18 && ahead <= std::min(0.9, distance) && lateral <= 0.28) {
      ++hits;
      nearest = std::min(nearest, std::hypot(dx, dy));
    }
  }
  if (hits < 3)
    return std::nullopt;
  return CorridorBlockage{nearest, hits};
}
} // namespace lattice
