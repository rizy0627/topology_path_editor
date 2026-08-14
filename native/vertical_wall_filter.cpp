#include <pcl/common/io.h>
#include <pcl/common/point_tests.h>
#include <pcl/features/normal_3d_omp.h>
#include <pcl/filters/filter.h>
#include <pcl/io/pcd_io.h>
#include <pcl/io/ply_io.h>
#include <pcl/point_types.h>
#include <pcl/search/kdtree.h>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

namespace {

using Cloud = pcl::PointCloud<pcl::PointXYZ>;

std::string lowercase(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
    return static_cast<char>(std::tolower(character));
  });
  return value;
}

bool loadCloud(const std::string& fileName, Cloud::Ptr cloud) {
  const auto extension = lowercase(std::filesystem::path(fileName).extension().string());
  if (extension == ".ply") return pcl::io::loadPLYFile(fileName, *cloud) >= 0;
  return pcl::io::loadPCDFile(fileName, *cloud) >= 0;
}

double parsePositiveDouble(const char* text, const char* label) {
  const double value = std::stod(text);
  if (!std::isfinite(value) || value <= 0.0) {
    throw std::invalid_argument(std::string(label) + " must be greater than zero");
  }
  return value;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 5) {
    std::cerr << "Usage: pcl_vertical_wall_filter INPUT OUTPUT NORMAL_RADIUS VERTICAL_TOLERANCE_DEG\n";
    return 2;
  }

  try {
    const double normalRadius = parsePositiveDouble(argv[3], "normal radius");
    const double toleranceDegrees = parsePositiveDouble(argv[4], "vertical tolerance");
    if (toleranceDegrees >= 90.0) throw std::invalid_argument("vertical tolerance must be below 90 degrees");

    auto input = Cloud::Ptr(new Cloud);
    if (!loadCloud(argv[1], input)) {
      std::cerr << "Failed to load input point cloud\n";
      return 3;
    }

    auto finiteCloud = Cloud::Ptr(new Cloud);
    std::vector<int> finiteIndexes;
    pcl::removeNaNFromPointCloud(*input, *finiteCloud, finiteIndexes);
    if (finiteCloud->empty()) {
      std::cerr << "Input point cloud has no finite XYZ points\n";
      return 4;
    }

    auto searchTree = pcl::search::KdTree<pcl::PointXYZ>::Ptr(new pcl::search::KdTree<pcl::PointXYZ>);
    pcl::NormalEstimationOMP<pcl::PointXYZ, pcl::Normal> estimator;
    estimator.setInputCloud(finiteCloud);
    estimator.setSearchMethod(searchTree);
    estimator.setRadiusSearch(normalRadius);

    pcl::PointCloud<pcl::Normal> normals;
    estimator.compute(normals);

    const double maxVerticalNormalZ = std::sin(toleranceDegrees * std::acos(-1.0) / 180.0);
    auto output = Cloud::Ptr(new Cloud);
    output->reserve(finiteCloud->size());
    std::size_t removed = 0;
    std::size_t invalidNormals = 0;

    for (std::size_t index = 0; index < finiteCloud->size(); ++index) {
      const auto& normal = normals[index];
      if (!pcl::isFinite(normal)) {
        output->push_back((*finiteCloud)[index]);
        ++invalidNormals;
        continue;
      }

      if (std::abs(normal.normal_z) <= maxVerticalNormalZ) {
        ++removed;
      } else {
        output->push_back((*finiteCloud)[index]);
      }
    }

    output->width = static_cast<std::uint32_t>(output->size());
    output->height = 1;
    output->is_dense = true;
    if (pcl::io::savePCDFileBinary(argv[2], *output) < 0) {
      std::cerr << "Failed to write filtered PCD\n";
      return 5;
    }

    std::cout << "{\"inputPoints\":" << finiteCloud->size()
              << ",\"outputPoints\":" << output->size()
              << ",\"removedPoints\":" << removed
              << ",\"invalidNormals\":" << invalidNormals << "}\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 2;
  }
}
