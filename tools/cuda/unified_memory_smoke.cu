#include <cuda_runtime.h>

#include <cmath>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <string>

namespace {

constexpr std::size_t kElements = 64ULL * 1024ULL * 1024ULL;

void check(cudaError_t status, const char* operation) {
  if (status != cudaSuccess) {
    std::cerr << "cuda_error operation=" << operation
              << " code=" << static_cast<int>(status)
              << " message=" << cudaGetErrorString(status) << '\n';
    std::exit(1);
  }
}

std::uint64_t mem_available_bytes() {
  std::ifstream input("/proc/meminfo");
  std::string key;
  std::uint64_t value = 0;
  std::string unit;
  while (input >> key >> value >> unit) {
    if (key == "MemAvailable:") {
      return value * 1024ULL;
    }
  }
  return 0;
}

__global__ void scale(float* values, std::size_t count, float multiplier) {
  const std::size_t index = blockIdx.x * blockDim.x + threadIdx.x;
  if (index < count) {
    values[index] *= multiplier;
  }
}

}  // namespace

int main() {
  int device_count = 0;
  check(cudaGetDeviceCount(&device_count), "cudaGetDeviceCount");
  if (device_count < 1) {
    std::cerr << "cuda_error operation=device-discovery message=no-device\n";
    return 1;
  }

  cudaDeviceProp properties{};
  check(cudaGetDeviceProperties(&properties, 0), "cudaGetDeviceProperties");

  int driver_version = 0;
  int runtime_version = 0;
  int concurrent_managed_access = 0;
  check(cudaDriverGetVersion(&driver_version), "cudaDriverGetVersion");
  check(cudaRuntimeGetVersion(&runtime_version), "cudaRuntimeGetVersion");
  check(
      cudaDeviceGetAttribute(
          &concurrent_managed_access,
          cudaDevAttrConcurrentManagedAccess,
          0),
      "cudaDeviceGetAttribute(concurrent-managed-access)");

  std::size_t allocator_free = 0;
  std::size_t allocator_total = 0;
  check(cudaMemGetInfo(&allocator_free, &allocator_total), "cudaMemGetInfo");

  const std::size_t allocation_bytes = kElements * sizeof(float);
  const std::uint64_t available_before = mem_available_bytes();
  float* values = nullptr;
  check(cudaMallocManaged(&values, allocation_bytes), "cudaMallocManaged");
  for (std::size_t index = 0; index < kElements; ++index) {
    values[index] = static_cast<float>(index % 1024);
  }
  const std::uint64_t available_after_cpu_touch = mem_available_bytes();

  const int threads = 256;
  const int blocks = static_cast<int>((kElements + threads - 1) / threads);
  scale<<<blocks, threads>>>(values, kElements, 2.0F);
  check(cudaGetLastError(), "scale-kernel-launch");
  check(cudaDeviceSynchronize(), "cudaDeviceSynchronize");
  const std::uint64_t available_after_gpu = mem_available_bytes();

  std::size_t checked = 0;
  for (std::size_t index = 0; index < kElements; index += 1048576) {
    const float expected = static_cast<float>((index % 1024) * 2);
    if (std::fabs(values[index] - expected) > 0.001F) {
      std::cerr << "verification_failed index=" << index << '\n';
      cudaFree(values);
      return 1;
    }
    ++checked;
  }

  check(cudaFree(values), "cudaFree");
  const std::uint64_t available_after_free = mem_available_bytes();

  std::cout << "device_name=" << properties.name << '\n';
  std::cout << "compute_capability=" << properties.major << '.' << properties.minor << '\n';
  std::cout << "cuda_driver_version=" << driver_version << '\n';
  std::cout << "cuda_runtime_version=" << runtime_version << '\n';
  std::cout << "concurrent_managed_access=" << concurrent_managed_access << '\n';
  std::cout << "allocator_total_bytes=" << allocator_total << '\n';
  std::cout << "allocator_free_bytes_before=" << allocator_free << '\n';
  std::cout << "managed_allocation_bytes=" << allocation_bytes << '\n';
  std::cout << "mem_available_bytes_before=" << available_before << '\n';
  std::cout << "mem_available_bytes_after_cpu_touch=" << available_after_cpu_touch << '\n';
  std::cout << "mem_available_bytes_after_gpu=" << available_after_gpu << '\n';
  std::cout << "mem_available_bytes_after_free=" << available_after_free << '\n';
  std::cout << "verified_samples=" << checked << '\n';
  std::cout << "result=pass\n";
  return 0;
}
