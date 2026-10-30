<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../README.vi.md)
<!-- doc-navigation:end -->

# công cụ gói ngoại tuyến Team AI Box

Trình cài đặt gốc được cấp phép MIT. Các gói bao gồm giấy phép gốc, kho lưu trữ của bên thứ ba và văn bản giấy phép trong kho băm tệp của họ. Điều này không cấp phép lại các mô hình, dịch vụ của Google, trình điều khiển hoặc các phần phụ thuộc vùng chứa dưới dạng MIT. Đọc [ranh giới phát hành](../docs/open-source/RELEASING.vi.md) trước khi phân phối; gói thử nghiệm hoàn chỉnh hiện có không tự động có giấy phép phân phối lại.

Khách hàng chạy **`sudo ./install.sh` trong gói đã chuẩn bị sẵn**. Người bảo trì xây dựng gói đó bằng `build-package.sh`. Khách hàng ngoại tuyến không cần kho lưu trữ Git, Node, Go, pip hoặc gói công khai.

Để tự động tải xuống, xây dựng và cài đặt từ bản sao công khai, hãy chạy `sudo bash install/from-source.sh`. Mạng ở Trung Quốc có thể sử dụng `--region cn`. Xem [SOURCE-INSTALL.md](SOURCE-INSTALL.vi.md) để biết thao tác, tiếp tục và chuyển ngoại tuyến. Sơ yếu lý lịch được hỗ trợ; chỉ có kết quả sẵn sàng cuối cùng mới xác lập được việc hoàn tất cài đặt. Việc thử nghiệm hoặc tải xuống thành công là chưa đủ.

Mục tiêu là một DGX Spark mới với hệ thống Ubuntu 24.04 ARM64 xuất xưởng và Docker Engine đang hoạt động, Compose v2, NVIDIA Bộ công cụ vùng chứa/GPU và KVM. Trình cài đặt không thay thế Docker/NVIDIA, khởi động lại Docker hoặc sao chép tài khoản, cơ sở dữ liệu, khóa hoặc máy ảo của công cụ phát triển.

> Hồ sơ chấp nhận cài đặt riêng vẫn được lưu trong kho lưu trữ lịch sử phát triển. Chúng không phải là tệp nguồn công cộng cũng như không phải là đầu vào xây dựng. Bằng chứng hiện tại về cài đặt lần đầu, tiếp tục và khôi phục khởi động không chỉ được chạy lại để xuất bản nguồn và không đủ điều kiện cho các hình ảnh mới được tạo tùy ý hoặc cấp quyền phân phối lại cho các tệp nhị phân của bên thứ ba.

## Người bảo trì: chuẩn bị đầu vào phát hành

**Đối với bản dựng GitHub công khai mới, hãy bắt đầu với [PUBLIC-BUILD.md](PUBLIC-BUILD.vi.md).** Nó bao gồm các hình ảnh công khai, thời gian chạy máy ảnh, tải xuống/lượng tử hóa mô hình và chương trình cơ sở mà không yêu cầu hình ảnh từ thiết bị phát triển. Các trình trợ giúp hình ảnh được phân lớp bên dưới hỗ trợ cập nhật dần dần các tạo phẩm đã được xác minh; chúng không phải là điều kiện tiên quyết cho một bản dựng mới.

Việc chuẩn bị có thể sử dụng internet. Cài đặt từ gói được phân phối không được tải xuống các phần phụ thuộc. Máy chủ đóng gói cần Python 3.10+, PyYAML, Git, Docker, `dpkg-deb` và có đủ dung lượng lưu trữ. Mô hình và hình ảnh có thể lớn; trình đóng gói giữ lại cả cây được trích xuất và `.tar`, ước tính không gian từ đầu vào thực tế. Nó không quét toàn bộ thiết bị phát triển cũng như không xuất các lớp có thể ghi từ các vùng chứa đang chạy.

1. Chuẩn bị hình ảnh ARM64 từ **một phiên bản phát hành** cho tất cả các vai trò bắt buộc. Sử dụng các điểm bắt đầu xây dựng trong `deploy/images/`, `deploy/appliance/` và các thư mục khách/mô hình tương ứng. API nền tảng, Tác nhân nút, bộ lập lịch và bộ điều khiển tác nhân phải hỗ trợ ID hình ảnh cục bộ; hình ảnh PostgreSQL phải chứa bảng kê khai di chuyển hiện tại, bao gồm cả di chuyển 116. Trình đóng gói không biên dịch một hình ảnh cũ tùy ý thành hình ảnh hiện tại. Với hình ảnh gốc cùng phiên bản đã được xác minh, hãy sử dụng `build_runtime_images.py --bases … --node-agent-binary … --output …` để tạo năm hình ảnh kế tiếp. `--bases` là bản đồ ID vai trò đến hình ảnh đầy đủ JSON. Đầu tiên hãy xây dựng Tác nhân nút bằng `GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build`. Trình trợ giúp này cấm việc kéo/xây dựng mạng, ghi lại danh tính nguồn/nguồn và tạo hình ảnh mới mà không triển khai hoặc thay đổi thẻ trực tiếp. ROM Android sạch cũng cần có bộ điều hợp mạng điều khiển hiện tại. Sử dụng `build_phone_images.py --bases <phone-role-image-ids.json> --output <new-directory>` để thêm `phone_network.py` vào cả hai lớp kế thừa ROM mà không cần truy cập mạng hoặc thay đổi dữ liệu ROM. Nó ghi lại ID hình ảnh chính xác và thông báo nguồn. Liên kết sidecar Android với cả ID mới chứ không phải ID trước đó. Xây dựng web và chín ứng dụng chính thức bằng cách sử dụng `build_application_images.py --node-base <clean-arm64-node-image-id> --guacamole-image <offline-guacamole-image-id> --output <new-directory>`. Đầu tiên hãy xây dựng trang web theo quy định của `apps/web/package.json`. Trình trợ giúp sử dụng các tệp Docker sản xuất, sửa thư mục web tại `/opt/teamaibox/web` và so sánh các tệp hình ảnh với các hàm băm đầu vào xây dựng hiện tại. Đừng cho rằng hình ảnh vùng chứa phát triển là một bản dựng web hoàn chỉnh: nó có thể phụ thuộc vào các biến thư mục tĩnh bổ sung hoặc chứa một thư mục cũ. Trình trợ giúp ngoại tuyến này không triển khai. Đặt tất cả mười ID hình ảnh mới vào đầu vào phát hành.
2. Thu thập các thư mục hoàn chỉnh, rõ ràng cho sáu mô hình: cấu hình, phân đoạn, mã thông báo, mã bắt buộc và giấy phép. Đồng thời chuẩn bị hai hình ảnh Android sạch, UEFI `CODE.fd`/`VARS.fd`, `virtio.iso` và tập lệnh thời gian chạy vẽ. Không thu thập các thư mục phiên bản điện thoại, ổ đĩa người dùng, trạng thái đăng nhập Google, ISO người dùng hoặc thông tin xác thực toàn cầu. ROM Android đã có sẵn bên trong `phone-runtime` / `phone-google-runtime`; không sao chép đĩa thứ hai. Thư mục nội dung `android-standard` / `android-google` chỉ chứa xuất xứ, giấy phép và `manifest.json`: `schemaVersion: 1`, `androidVersion: "17"`, `baseBuildId: "16102939"`, `systemFamily: "standard"` or `"google-play"` và `runtimeImageId: "sha256:…"`. ID phải khớp với hình ảnh thời gian chạy đã xuất. Thư mục trình điều khiển chỉ chứa `virtio.iso`; thư mục phát triển cũng chứa `windows.iso` bị từ chối.
3. Xây dựng hai công cụ máy chủ Linux ARM64 đi kèm mà không cần cài đặt chúng trên máy chủ xây dựng:

   ```sh
   python3 install/build_guest_tools.py --output /build/artifacts/guest-host-tools
   ```

4. Trên máy chủ xây dựng ARM64 được kết nối internet, hãy thu thập các phần phụ thuộc của công cụ máy chủ bằng cách sử dụng hình ảnh Ubuntu 24.04 cục bộ rõ ràng. Sử dụng ID hình ảnh đã được xác minh trên máy chủ đó chứ không phải ID được sao chép từ công cụ phát triển:

   ```sh
   python3 install/collect_host_packages.py \
     --base-image "$UBUNTU_ARM64_IMAGE_ID" --output /build/artifacts/host-packages
   ```

   Chỉ thu thập các phần phụ thuộc cho cryptsetup, ext4, USB/máy ảnh, công cụ hình ảnh QEMU, mạng và các tiện ích hệ thống nhỏ. Các gói thay thế Docker, containerd, NVIDIA, CUDA và kernel đều bị cấm. Việc lắp đặt chỉ cung cấp các công cụ còn thiếu; apt đọc kho lưu trữ tệp cục bộ của gói bằng `--no-download --no-remove` mà không cần dự phòng trực tuyến.

5. Tạo tệp kê khai đầu vào phát hành và cung cấp **đường dẫn tạo tác rõ ràng và ID nội dung hình ảnh cục bộ**:

   ```sh
   python3 install/prepare-release.py --template /build/artifact-inputs.json
   python3 install/prepare-release.py --inputs /build/artifact-inputs.json \
     --output /build/prepared-release
   ```

   Mẫu bao gồm tất cả 41 vai trò hình ảnh và 12 danh mục nội dung bên ngoài; một tài sản khác của nhà máy được tạo ra bởi các công cụ này. Phần giữ chỗ không thể nhập một gói. `sourceCommit` phải khớp với phần thanh toán, `agentVersion` bản dựng Đại lý thực tế và `hostPackageCollection` bước 4 `collection.json`. Đường dẫn máy chủ xây dựng là đầu vào của bộ sưu tập, không phải cấu hình thời gian chạy của khách hàng. Sử dụng trình tạo nhà máy hiện tại: các tuyến đường `drawing.automatic` / `drawing.fast` của giao diện người dùng bản vẽ phải khớp với cấu hình mô hình cục bộ. Sức khỏe của người lao động hoặc chỉ một cuộc gọi mô hình trực tiếp không xác định được mức độ sẵn sàng của ứng dụng. Bao bì từ chối các mẫu nhà máy cũ thiếu các ánh xạ này.

Hợp đồng vai trò hình ảnh được báo cáo bởi `python3 install/package.py --describe-contract`:

- Core, web, team drive, nhắn tin, cổng, bộ lập lịch, bảo trì, plugin, hộp cát tác nhân động và cổng nguồn gói.
- Chín plugin ứng dụng, sáu nhân viên mô hình văn phòng và thời gian chạy ASR/loa theo yêu cầu.
- Android tiêu chuẩn, Google Android, thời gian chạy máy tính và cổng âm thanh/hiển thị web.
- Thu phát, xử lý đa phương tiện và SFU.

Hai vai trò có thể chia sẻ một ID nội dung hình ảnh; kho lưu trữ của nó chỉ được xuất một lần. Các chỉ mục phân đoạn mô hình cũng được kiểm tra: băm tệp phù hợp không loại trừ phân đoạn bị thiếu. Các công cụ máy chủ phải là tệp nhị phân ARM64 ELF thực tế.

## Xây dựng gói

```sh
./install/build-package.sh --release /build/prepared-release/release-input.json \
  --output /build/output
```

Đầu ra là `teamaibox-<releaseId>-linux-arm64.tar`, tệp `.sha256` của nó và thư mục được giải nén. Việc sao chép, xuất hình ảnh, băm và lưu trữ diễn ra trong một thư mục tạm thời trước khi tổng kiểm tra cuối cùng được xuất bản. Kết quả đầu ra hiện tại không bị ghi đè; một bản dựng bị gián đoạn không được giống như một bản phát hành hoàn chỉnh. Đối với những thay đổi chỉ dành cho trình cài đặt với nhận dạng hình ảnh không thay đổi, hãy sử dụng `--image-cache <previous-extracted-package>`. Toàn bộ gói cũ được xác minh trước khi kho lưu trữ của nó được sử dụng lại bằng ID hình ảnh thực tế và gói mới được xác minh lại. Không có dữ liệu nào được lấy từ lớp cài đặt cũ hoặc lớp có thể ghi trong vùng chứa. Điều này tránh xuất lại hàng trăm GB hình ảnh giống hệt nhau.

Một bản phát hành thông thường yêu cầu các tệp nguồn đi kèm của nó phải thuộc về cam kết Git đã khai báo. Một `--allow-working-tree` rõ ràng tạo ra một ứng cử viên phát triển; Bản kê khai của nó ghi lại `candidate: true` và các tệp đã thay đổi. Việc vượt qua sự chấp nhận tập trung không biến nguồn không được cam kết thành một bản phát hành đã xuất bản.

Bố trí gói:

```text
teamaibox-<releaseId>-linux-arm64/
  install.sh, installer.py, offline_common.py, offline_host_packages.py
  README.zh-CN.md, release.json, checksums.sha256
  images/          # Docker archives deduplicated by content ID
  assets/          # Models, Android, computers, tools and factory configuration by role
  host-packages/   # Complete .deb dependency set
  runtime/         # Installer adapters and recovery-tool module closure
```

Xác minh độc lập bằng `./install/build-package.sh --verify /build/output/teamaibox-<releaseId>-linux-arm64`. Điều này kiểm tra tính toàn vẹn; nó không chứng tỏ khả năng khởi động thành công trên phần cứng mới.

## Khách hàng: cài đặt ngoại tuyến và tiếp tục

Đọc [hướng dẫn cài đặt gói](PACKAGE-README.vi.md). Gốc mặc định là `/srv/teamaibox/installation`. LUKS/ext4 chỉ được tạo bên trong `volume/data.img` mới, không phải trên đĩa hệ thống hoặc các đĩa hiện có. Nhóm dữ liệu sử dụng dung lượng lưu trữ sẵn có trừ đi giới hạn an toàn vật lý, không phải giới hạn 256 GiB cố định. Các mô hình, tệp doanh nghiệp và dữ liệu khách nằm trong ổ đĩa được mã hóa; Docker hiện có quản lý hình ảnh vùng chứa.

Cài đặt mới sẽ tạo quản trị viên `admin` với mật khẩu ban đầu `admin`. Người dùng thông thường được tạo bởi quản trị viên. Thay đổi mật khẩu ban đầu trước khi giao/sử dụng. Điều này chỉ áp dụng cho cơ sở dữ liệu tài khoản trống: tiếp tục, chạy lại, khởi động lại và nâng cấp không đặt lại tài khoản hoặc mật khẩu hiện có. Nhận dạng thiết bị, thông tin xác thực dịch vụ, chứng chỉ và mã khôi phục của quản trị viên được tạo độc lập, không sao chép từ thiết bị khác. Quá trình chuẩn bị bộ nhớ đệm nhân GPU ban đầu chạy trên thiết bị bằng cách sử dụng các công cụ và mô hình đi kèm; bộ nhớ đệm tương thích được giữ lại. Boot recovery khôi phục dữ liệu và dịch vụ thiết bị trước tiên, sau đó là các dịch vụ cốt lõi và từng nhân viên AI. Trình cài đặt chỉ chạy trong khi cài đặt; nó không thêm trình quản lý trình cài đặt thường trú.

Sau khi bị gián đoạn, lặp lại lệnh ban đầu. Các bước hoàn thành được xác minh; không che giấu xung đột bằng cách xóa dữ liệu hoặc tạo lại vùng chứa. Chạy lại bản cài đặt cùng phiên bản đã hoàn thành chỉ kiểm tra nó; các phiên bản khác nhau sử dụng đường dẫn nâng cấp chính thức. Chi tiết lỗi nằm trong `install-state.json`, `readiness.json` và các bản ghi giai đoạn trong thư mục gốc cài đặt.

## Ranh giới xác minh

Các thử nghiệm dành riêng cho trình cài đặt sử dụng các tạo phẩm cấu trúc nhỏ, tệp tạm thời và cơ sở dữ liệu ngoại tuyến/trình nền Docker bị cô lập. Họ không được truy cập cơ sở dữ liệu kinh doanh hoặc gắn các đĩa VM hiện có. Một bản cài đặt mới thực sự cần có một DGX Spark tương thích được chỉ định rõ ràng cho mục đích đó; không xóa một thiết bị kinh doanh. Việc chấp nhận bao gồm việc khởi động, tiếp tục và khôi phục khởi động ở mức tối thiểu cho bản cài đặt mới, không phải các thử nghiệm kinh doanh không liên quan. Bản thân việc chuẩn bị giải phóng nguồn không xóa, cài đặt lại hoặc triển khai các thiết bị hiện có.

Trên máy chủ bản dựng, hãy chạy `sudo python3 install/verify_bundle_offline.py --package <extracted-package> --output <new-test-directory>` để nhập gói đầy đủ vào một trình nền Docker riêng biệt có bộ nhớ đệm trống và không có mạng công cộng. Nó không gọi tập lệnh cài đặt mới, sử dụng GPU, gắn kết thư mục khách hàng hoặc khởi động lại Docker hệ thống. Báo cáo của nó rõ ràng không yêu cầu cài đặt phần cứng đầy đủ. Hình ảnh kiểm tra vẫn nằm trong thư mục kiểm tra chuyên dụng, cần thêm dung lượng ổ đĩa và không vào kho hình ảnh của Docker hệ thống.
