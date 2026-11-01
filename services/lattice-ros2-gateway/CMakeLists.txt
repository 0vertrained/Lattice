cmake_minimum_required(VERSION 3.16)
project(lattice_ros2_gateway LANGUAGES CXX)

if(NOT CMAKE_CXX_STANDARD)
  set(CMAKE_CXX_STANDARD 20)
endif()

set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(ament_cmake REQUIRED)
find_package(rclcpp REQUIRED)
find_package(rclcpp_lifecycle REQUIRED)

add_executable(lattice_ros2_gateway src/main.cpp)
target_compile_options(lattice_ros2_gateway PRIVATE -Wall -Wextra -Wpedantic -Werror)
ament_target_dependencies(lattice_ros2_gateway rclcpp rclcpp_lifecycle)

install(TARGETS lattice_ros2_gateway DESTINATION lib/${PROJECT_NAME})
ament_package()
