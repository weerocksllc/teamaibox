<!-- doc-navigation:start -->
[English](PUBLIC-BUILD.md) · [简体中文](PUBLIC-BUILD.zh-CN.md) · [繁體中文](PUBLIC-BUILD.zh-TW.md) · [日本語](PUBLIC-BUILD.ja.md) · [한국어](PUBLIC-BUILD.ko.md) · [Français](PUBLIC-BUILD.fr.md) · [Deutsch](PUBLIC-BUILD.de.md) · [Español](PUBLIC-BUILD.es.md) · [Português](PUBLIC-BUILD.pt-BR.md) · [Русский](PUBLIC-BUILD.ru.md) · [العربية](PUBLIC-BUILD.ar.md) · [हिन्दी](PUBLIC-BUILD.hi.md) · [Bahasa Indonesia](PUBLIC-BUILD.id.md) · [Italiano](PUBLIC-BUILD.it.md) · [Türkçe](PUBLIC-BUILD.tr.md) · [Tiếng Việt](PUBLIC-BUILD.vi.md) · [ไทย](PUBLIC-BUILD.th.md)

[Team AI Box — README](../README.vi.md)
<!-- doc-navigation:end -->

# Xây dựng một thiết bị từ nguồn công cộng

Điểm nhập điều phối mới được ghi lại trong [SOURCE-INSTALL.md](SOURCE-INSTALL.vi.md). Nó tự động hóa các công thức nấu ăn bên dưới; trạng thái xác minh toàn bộ thiết bị của nó được nêu ở đó. Những công thức nấu ăn thủ công này vẫn có sẵn cho người bảo trì và chẩn đoán từng giai đoạn.

Đây là đường dẫn từ nguồn tới gói. Nó không nhập cài đặt Team AI Box trước đó, vùng chứa, tài khoản, chứng chỉ, khách hoặc cơ sở dữ liệu của nó. Máy xây dựng cần truy cập internet; kết quả là gói hoàn chỉnh được cài đặt ngoại tuyến. Khách hàng cung cấp riêng phương tiện cài đặt Windows/Linux.

Sử dụng Linux ARM64 (Ubuntu 24.04), Docker/BuildKit, Python 3.10+, PyYAML, jq, Git, Go 1.26 và có đủ dung lượng ổ đĩa để tải xuống nguồn, xây dựng các lớp và gói không nén cuối cùng. Lượng tử hóa mô hình cũng yêu cầu GPU NVIDIA tương thích với đủ bộ nhớ trống. Không dừng khối lượng công việc khác để lấy bộ nhớ đó mà không có sự cho phép của chủ sở hữu máy. Docker và NVIDIA là điều kiện tiên quyết, không phải thành phần được trình cài đặt thay thế.

Chạy các lệnh từ một lần thanh toán công khai mới. Đặt `BUILD` thành thư mục bản dựng mới, tuyệt đối **bên ngoài** thanh toán. Đầu ra, mô hình và báo cáo không được cam kết. Mọi người trợ giúp đều từ chối một đầu ra bị chiếm dụng trừ khi nó ghi lại một hoạt động tiếp tục cụ thể. Sử dụng các tham chiếu/ID của báo cáo thành công, không phải tên hình ảnh được sao chép từ máy của người khác. ID nội dung Docker cục bộ không phải là tham chiếu đăng ký có thể tải xuống; Các đối số cha của Dockerfile cần thẻ cục bộ tương ứng hoặc thông báo ngược dòng đủ điều kiện.

## 1. Dịch vụ và ứng dụng

```sh
python3 install/build_public_services.py --output "$BUILD/services" \
  --network host \
  --guacamole-image docker.io/guacamole/guacamole@sha256:f344085e618bb05e22b964b0208dbd06d3468275bac70206f93805245e067b40 \
  --guacd-image docker.io/guacamole/guacd@sha256:8974eaa9ba32f713daf311e7cc8cd7e4cdfba1edea39eed75524e78ef4b08f4f \
  --roles platform-api web postgres event-bus node-agent agent-bridge \
  object-service messaging scheduler plugin-runtime observability \
  compute-gateway appliance-gateway maintenance-controller source-gateway \
  agent-sandbox computer-runtime desktop-gateway desktop-proxy \
  casting-receiver casting-media assistant-worker embedding-worker \
  translation-worker drawing-worker ocr-worker asr-worker batch-asr-worker \
  speaker-diarization-worker messaging-plugin team-drive-plugin drawing-plugin \
  ocr-plugin asr-plugin translation-plugin virtual-phones-plugin \
  virtual-computers-plugin wireless-casting-plugin

python3 install/build_public_sfu.py \
  --cache "$BUILD/downloads" --output "$BUILD/sfu"
```

`--network host` ảnh hưởng đến **bản dựng** trực tuyến, không ảnh hưởng đến mạng dịch vụ được cài đặt. Các giai đoạn phụ thuộc của nút cho phép 2 giây cho mỗi lần thử kết nối thay vì mặc định của Nút là 250 mili giây. Điều này giúp cho các bản tải xuống npm chính thức có thể sử dụng được trên các liên kết có độ trễ cao hơn, bao gồm cả VPN do người dùng quản lý mà không cần chuyển đổi sổ đăng ký, vô hiệu hóa IPv6 hoặc làm suy yếu quá trình kiểm tra tính toàn vẹn của gói/TLS. Cài đặt này là đối số ở giai đoạn xây dựng, không phải thay đổi môi trường trong ứng dụng đã cài đặt. Đối với liên kết chậm hơn, bản dựng Docker trực tiếp có thể ghi đè `--build-arg NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000`. Hình ảnh web xây dựng các phần phụ thuộc và nội dung bị khóa của riêng nó. Các dịch vụ nút chia sẻ phần đóng phụ thuộc API mới được xây dựng. OCR bao gồm bộ điều hợp công cộng của nó; nó không cần gói công nhân chưa được xuất bản từ một dự án khác. Bản dịch sử dụng hình ảnh vLLM NVIDIA công khai được ghim. Nhúng, ASR hàng loạt và phương tiện truyền phát có chủ ý chia sẻ hình ảnh thời gian chạy công khai tương ứng của chúng. Hình ảnh máy tính xây dựng QEMU 11.1.1 đã được xác minh bằng chữ ký với hỗ trợ ARM TPM/PPI, KVM, VNC và PulseAudio, duy trì khả năng của thời gian chạy Windows ban đầu. Debian cung cấp các thư viện thời gian chạy, nhưng QEMU đóng gói cũ hơn của nó không được thay thế tệp thực thi này. Hình ảnh cuối cùng kiểm tra cả thuộc tính ARM TIS `ppi` và phần phụ trợ PulseAudio, đồng thời bao gồm ROM bộ đệm khung RAM phù hợp. Xem [hướng dẫn thời gian chạy máy tính ảo](../deploy/windows-computer/README.vi.md) để biết yêu cầu cập nhật về thăm dò thời gian chạy giới hạn và yêu cầu cập nhật bảo toàn dữ liệu.

Mỗi vai trò có một nhật ký. Một báo cáo thất bại sẽ duy trì các kết quả đầu ra có vai trò thành công; chỉ xây dựng vai trò bị lỗi và hợp nhất các báo cáo thành công sau này. Không thay thế vùng chứa phát triển đang chạy bằng hình ảnh bị thiếu.

## 2. Thời gian chạy máy ảnh và Android không cần tài khoản

Các khóa ghim bản dựng AOSP, gói máy chủ, đầu vào kernel và các bản sửa đổi nguồn của Google. Tải xuống được kiểm tra trước khi sử dụng. Không có khách nào được khởi động trong quá trình lắp ráp.

```sh
python3 install/build_public_android.py --cache "$BUILD/android-downloads" \
  --output "$BUILD/android"
PHONE_BASE=$(jq -r '.images.network.reference' "$BUILD/android/build.json")
docker build --network host --build-arg PHONE_BASE_IMAGE="$PHONE_BASE" \
  -f deploy/android/cuttlefish/GappsTools.Dockerfile \
  -t teamaibox-build:phone-tools deploy/android/cuttlefish

python3 install/build_public_camera_backend.py --cache "$BUILD/camera-downloads" \
  --output "$BUILD/camera-backend"
CAMERA_COMPILER=$(jq -r '.compiler' "$BUILD/camera-backend/build.json")
python3 install/fetch_public_camera_kernel.py --output "$BUILD/kernel"
python3 tools/prepare_phone_camera_guest_driver.py --output "$BUILD/guest-source"
python3 tools/build_phone_camera_guest_driver.py --inputs "$BUILD/kernel" \
  --source "$BUILD/guest-source" --compiler-image "$CAMERA_COMPILER" \
  --output "$BUILD/guest-driver"
```

Đối với bản vá APK máy ảnh, hãy cài đặt các công cụ dòng lệnh Android công khai của Google, nền tảng `android-36.1`, công cụ xây dựng `36.1.0` và bản phát hành Java hỗ trợ JDK
8. Đặt `ANDROID_SDK_ROOT` and `JDK_HOME` vào các thư mục công cụ đó. Các công cụ này là các phần phụ thuộc được xây dựng chứ không phải hồ sơ người dùng Android được xuất. Trên ARM64 Linux, gói `zipalign` của Google có thể chỉ x86: cài đặt gói ARM64 `zipalign` của Ubuntu và chuyển `--zipalign /usr/bin/zipalign` bên dưới. D8 và apksigner là các chương trình Java. Ngoài ra, bản dựng APK có thể chạy trên máy chủ SDK được hỗ trợ riêng biệt; chỉ chuyển hai tệp đầu ra của nó (`Camera2.apk`, `camera-preview.json`), không bao giờ chuyển cài đặt Android hoặc hồ sơ người dùng của máy chủ đó.

Trích xuất APK gốc từ bản dựng AOSP sạch (thư mục đầu ra phải tồn tại và có thể ghi được bởi bộ chứa bản dựng):

```sh
mkdir "$BUILD/stock-camera"
docker run --rm --network none --read-only --user 0:0 --tmpfs /tmp:size=2g \
  --entrypoint python3 \
  --mount "type=bind,src=$PWD/deploy/android/cuttlefish,dst=/build,readonly" \
  --mount "type=bind,src=$BUILD/stock-camera,dst=/work" \
  teamaibox-build:phone-tools /build/prepare_camera_rom_inputs.py
python3 install/build_public_camera_apk.py \
  --stock "$BUILD/stock-camera/inputs/stock-Camera2.apk" \
  --sdk "$ANDROID_SDK_ROOT" --java-home "$JDK_HOME" --output "$BUILD/camera-apk"
python3 install/build_public_phone_rom.py --base-image "$PHONE_BASE" \
  --tools-image teamaibox-build:phone-tools --apk "$BUILD/camera-apk" \
  --module "$BUILD/guest-driver" --output "$BUILD/camera-rom"
PHONE_PARTITIONS=$(jq -r '.reference' "$BUILD/camera-rom/build.json")
python3 install/build_public_phone_runtime.py --base-image "$PHONE_PARTITIONS" \
  --backend "$BUILD/camera-backend" --cache "$BUILD/camera-downloads" \
  --output "$BUILD/phone"
```

APK giữ lại **người ký kiểm tra AOSP công khai** đã biết, không phải khóa sản phẩm riêng tư. Trình trợ giúp xác minh chứng chỉ gốc và chứng chỉ kết quả cũng như tài nguyên APK không thay đổi, đồng thời xóa tài liệu ký tạm thời. Đây không phải là tài khoản hoặc danh tính thiết bị Google.

Hợp đồng cài đặt hoàn chỉnh hiện tại cũng bao gồm một biến thể thử nghiệm của Google Android. Khóa đầu vào công khai và kiểm tra chữ ký của nó **không** cấp chứng nhận cho Google hoặc quyền phân phối lại. Chỉ xây dựng/sử dụng nó theo các điều khoản hiện hành của bên thứ ba; không xuất bản gói đầy đủ dưới dạng bản tải xuống MIT không hạn chế.

```sh
PHONE_RUNTIME=$(jq -r '.references["phone-runtime"]' "$BUILD/phone/images.json")
docker build --network host --build-arg PHONE_BASE_IMAGE="$PHONE_RUNTIME" \
  -f deploy/android/cuttlefish/GappsTools.Dockerfile \
  -t teamaibox-build:google-tools deploy/android/cuttlefish
python3 install/inspect_public_phone_inputs.py --cache "$BUILD/google-downloads" \
  --tools-image teamaibox-build:google-tools --output "$BUILD/google-inputs"
python3 install/build_public_google_phone.py --base-image "$PHONE_RUNTIME" \
  --tools-image teamaibox-build:google-tools --inspection "$BUILD/google-inputs" \
  --output "$BUILD/google-phone"
```

## 3. File mô hình nhà xuất bản và công thức lượng tử hóa công khai

```sh
for role in embedding-model drawing-model ocr-model asr-model; do
  python3 install/fetch_public_models.py --role "$role" \
    --output "$BUILD/assets/$role"
done
for role in assistant translation; do
  python3 install/fetch_public_models.py --role "$role-source" \
    --output "$BUILD/model-sources/$role"
done
OFFICE_ENGINE=$(jq -r '.references["assistant-worker"]' "$BUILD/services/images.json")
docker build --network host --build-arg OFFICE_ENGINE_IMAGE="$OFFICE_ENGINE" \
  -f deploy/compute/qwen38-modelopt/Dockerfile \
  -t teamaibox-build:modelopt deploy/compute/qwen38-modelopt
for role in assistant translation; do
  python3 install/prepare_public_quantized.py --role "$role" \
    --source "$BUILD/model-sources/$role" --tools-image teamaibox-build:modelopt \
    --output "$BUILD/quantized/$role"
done
```

Tất cả các bản tải xuống mô hình đều sử dụng các bản sửa đổi bất biến trong `deploy/compute/*profile*` và hàm băm Git/LFS của nhà xuất bản. `--cache <directory>` tùy chọn ở chế độ chỉ đọc và chỉ chấp nhận tệp khi byte của chúng khớp với nhà xuất bản. Đây không phải là cách để nhập thư mục mô hình đã cài đặt một cách bừa bãi. Văn bản MIT độc lập của ASR được ghim vào bản phát hành Whisper ban đầu vì ảnh chụp nhanh mô hình đã chuyển đổi chỉ khai báo giấy phép. OCR giữ lại giấy phép riêng của mình, không phải MIT. Bản dịch được ghim và thẻ mô hình nhúng khai báo Apache-2.0 mà không gửi văn bản độc lập của nó; những người trợ giúp của họ bao gồm giấy phép Apache được ghim tổng kiểm tra và bản ghi xuất xứ sau khi kiểm tra tuyên bố đó.

Quá trình tải xuống phù hợp bị gián đoạn hỗ trợ `--resume`. `--transfer ranges` sử dụng phạm vi HTTP có thể tiếp tục bị giới hạn; `--transfer huggingface` yêu cầu gói `huggingface_hub`/`hf_xet` chính thức và vô hiệu hóa việc sử dụng mã thông báo. Các phần và bộ đệm tải xuống vẫn nằm ngoài các thư mục mô hình có thể xuất bản. Tổng kiểm tra là bắt buộc với mỗi lần vận chuyển. Đừng làm suy yếu chúng đối với các trang đăng nhập/thử thách HTML hoặc các trang tải xuống bị cắt bớt.

Lượng tử hóa chạy ngoại tuyến trong một vùng chứa bản dựng riêng biệt bằng cách sử dụng dữ liệu hiệu chỉnh tổng hợp công khai của ModelOpt, không bao giờ có lịch sử trò chuyện. Chỉ những đầu ra có `build.json` cho biết `quantized` mới có thể cung cấp `assistant-model` and `translation-model`; chọn thư mục con `model/` của chúng, không phải nguồn thô hoặc toàn bộ không gian làm việc của bản dựng. Sau khi xác thực các đầu vào, các bản dựng Linux sẽ khuyên kernel giải phóng các trang được lưu trong bộ nhớ cache của các tệp cụ thể đó. Điều này tránh gây nhầm lẫn khi đọc bộ nhớ GPU không có ngay lập tức trên bộ nhớ dùng chung của GB10; nó không xóa trọng lượng, xóa bộ nhớ đệm trên toàn máy chủ hoặc dừng khối lượng công việc. Đối với một GPU GB10, trình trợ giúp sẽ phân bổ ngân sách từ Linux `MemAvailable` và dự trữ dung lượng để hiệu chỉnh cũng như máy chủ. Nó từ chối không đủ dung lượng thay vì âm thầm chấp nhận bản dựng chủ yếu là CPU. Khi mô hình đầy đủ phù hợp, ngân sách ModelOpt rõ ràng sẽ tránh đường dẫn xuất giảm tải CPU không cần thiết của Accelerate. Bộ chứa bản dựng cũng đặt bộ nhớ bị khóa không giới hạn và ngăn xếp 64 MiB, tuân theo các yêu cầu khởi chạy lượng tử hóa của [NVIDIA](https://build.nvidia.com/spark/nvfp4-quantization/instructions). Các cài đặt này nằm trong phạm vi vùng chứa bản dựng chứ không phải giới hạn trên toàn máy chủ.

## 4. Hoàn thiện gói đầu vào

```sh
python3 install/merge_public_images.py --report "$BUILD/services/images.json" \
  --report "$BUILD/sfu/images.json" --report "$BUILD/phone/images.json" \
  --report "$BUILD/google-phone/images.json" --output "$BUILD/images.json"
python3 install/prepare_public_resources.py --images "$BUILD/images.json" \
  --driver-cache "$BUILD/downloads/virtio-win-0.1.285.iso" \
  --output "$BUILD/resources"
python3 install/build_guest_tools.py --output "$BUILD/guest-tools"
```

Việc sáp nhập phải báo cáo **41 vai trò và không thiếu vai trò nào**. Nó xác minh cấu trúc hình ảnh/ID nội dung và loại bỏ các đầu ra xung đột. Các tài nguyên chỉ chứa chương trình cơ sở UEFI ngược dòng (bao gồm mẫu lưu trữ biến mới), ISO trình điều khiển virtio được ghim tổng kiểm tra, thời gian chạy bản vẽ nguồn và các thông báo Android được liên kết với các hình ảnh mới được tạo. ISO không phải là phương tiện cài đặt Windows. Máy nhân bản Microsoft OpenVMM giống hệt tổng kiểm tra của nó tránh dựa vào trang tải xuống Fedora tương tác.

Thu thập các gói máy chủ có `collect_host_packages.py` như được mô tả trong [README.md](README.vi.md), sau đó tạo mẫu với `prepare-release.py --template`. Điền vào bản đồ hình ảnh của nó từ `images.json`; điền vào tất cả 12 vai trò nội dung từ kết quả đầu ra của mô hình, `resources/assets.json` and `guest-tools`. Đặt `sourceCommit` thành phiên bản thanh toán và phiên bản đại lý thực tế. Không có phần giữ chỗ hoặc cấu hình cài đặt trước đó được chấp nhận.

Chạy `prepare-release.py --inputs … --output …`, sau đó `build-package.sh` bằng cách sử dụng bản phát hành đã chuẩn bị đó. Các nguồn được sửa đổi/không được cam kết yêu cầu cờ ứng viên `--allow-working-tree` rõ ràng; chúng không phải là một cam kết được phát hành. Xem [PACKAGE-README.md](PACKAGE-README.vi.md) để biết cách cài đặt. Cơ sở dữ liệu tài khoản trống mới nhận được `admin/admin`; tất cả thông tin xác thực dịch vụ và nhận dạng thiết bị đều được tạo độc lập. Chỉ bản dựng không chứng minh được việc cài đặt thành công.

## Công thức nấu ăn theo lớp lịch sử và kiểm tra xuất bản

Các tệp Dockerfile chẩn đoán/phân lớp cũ hơn được giữ lại để bảo trì nguồn, không được đường dẫn này sử dụng. Đối số `BUILD_PARENT_N` của họ cố tình không có mặc định hình ảnh riêng tư. Cung cấp cha mẹ tương thích mà bạn đã xây dựng hoặc sử dụng kênh công cộng ở trên; đừng đoán một thông báo phát triển không có sẵn.

Trước khi xuất bản, hãy chạy trình bảo vệ nguồn và trình quét bí mật, xem lại lịch sử riêng biệt và loại trừ tất cả các thư mục bản dựng, gói, đĩa khách, dữ liệu tài khoản và trang web riêng tư. Các báo cáo chứa đường dẫn cục bộ nằm ngoài cây công khai. Việc xác minh cho công việc này được giới hạn ở việc đóng đầu vào, nhận dạng tạo tác, cài đặt và các đường dẫn dịch vụ tối thiểu mới được cài đặt; nó không chạy lại việc chấp nhận kinh doanh không liên quan.
