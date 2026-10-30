<!-- doc-navigation:start -->
[English](BUILDING.md) · [简体中文](BUILDING.zh-CN.md) · [繁體中文](BUILDING.zh-TW.md) · [日本語](BUILDING.ja.md) · [한국어](BUILDING.ko.md) · [Français](BUILDING.fr.md) · [Deutsch](BUILDING.de.md) · [Español](BUILDING.es.md) · [Português](BUILDING.pt-BR.md) · [Русский](BUILDING.ru.md) · [العربية](BUILDING.ar.md) · [हिन्दी](BUILDING.hi.md) · [Bahasa Indonesia](BUILDING.id.md) · [Italiano](BUILDING.it.md) · [Türkçe](BUILDING.tr.md) · [Tiếng Việt](BUILDING.vi.md) · [ไทย](BUILDING.th.md)

[Team AI Box — README](../../README.vi.md)
<!-- doc-navigation:end -->

# Xây dựng nguồn

Tạo phẩm công khai là nguồn chứ không phải hình ảnh công cụ ngoại tuyến dựng sẵn. Bản dựng nguồn có thể tải xuống các phần phụ thuộc; cài đặt bằng gói đầy đủ đã chuẩn bị sẵn vẫn ngoại tuyến. Cả hai quá trình đều không cần SDK ViKey hoặc khóa USB.

Để cài đặt công cụ hoàn chỉnh, hãy bắt đầu với [khởi động nhanh](../../README.vi.md#install) gốc và [trình cài đặt nguồn](../../install/SOURCE-INSTALL.vi.md): `sudo bash install/from-source.sh` tải xuống, xây dựng, đóng gói và cài đặt trên Spark mới tương thích. Bản dựng web phát triển bên dưới không phải là trình cài đặt đó và không khởi động sản phẩm hoàn chỉnh.

## Phát triển

Sử dụng Node.js 24, pnpm 11.1.3 (xem root `package.json`), Python 3.10+ và phiên bản Go được khai báo trong mỗi `go.mod` (node-agent hiện là 1.26). Trên máy xây dựng:

Việc xuất nguồn có chủ ý không có lịch sử Git riêng tư. Trước khi chạy các công cụ nguồn trên cây đã xuất đó, hãy khởi tạo kho lưu trữ của riêng bạn và cam kết cây đã xem xét của bạn (`git init`, `git add .`, `git commit`). Bản sao Git công khai bình thường không cần bước này. Sử dụng cam kết mới đó làm danh tính bản dựng; không yêu cầu cây được xuất, sửa đổi là cam kết giao hàng cũ.

```sh
pnpm install --frozen-lockfile
pnpm --filter @teamaibox/web build
python3 tools/open_source_inventory.py --check
```

Quá trình xây dựng web là quá trình kiểm tra biên dịch chứ không phải quá trình chấp nhận sản phẩm. Các dịch vụ thời gian chạy sử dụng Dockerfiles trong `deploy/`. Việc thực thi DGX Spark yêu cầu Linux ARM64 và môi trường NVIDIA/Docker hiện có. Kiểm tra nguồn máy tính để bàn không phải là sự thay thế cho phần cứng đó. Không sử dụng các tập lệnh lab lịch sử làm trình cài đặt.

Những người trợ giúp xây dựng nhà máy Python cũng yêu cầu PyYAML; xem phần phụ thuộc của trình cài đặt trước. Không cần cài đặt đĩa hệ điều hành hoặc tài khoản nhà phát triển.

## Đã loại trừ các đầu vào được biên dịch

Nhà xuất khẩu bỏ qua các tệp nhị phân, ngay cả khi tiện ích mở rộng của chúng trông vô hại:

- Xây dựng `services/node-agent` và trình trợ giúp `cmd/factory-worker-spec` của nó từ nguồn Go; tệp thực thi gốc kho lưu trữ `node-agent` không phải là đầu vào nguồn.
- APK cố định Android và tệp ký không được gửi. Nguồn và tệp kê khai của chúng trong `tools/fixtures/` vẫn có sẵn cho các bản dựng thử nghiệm cục bộ.
- Bản dựng truyền thiết bị hiện tại sử dụng `deploy/appliance/wireless-casting-plugin.Dockerfile`. Nó không cần kho lưu trữ gói Alpine cũ. Thay vào đó, nếu bạn sử dụng plugin độc lập Dockerfile, hãy lấy các gói chính xác được xác định trong [tệp kê khai tổng kiểm tra ngược dòng](../../apps/wireless-casting-plugin/vendor/alpine/security-update-20261010.json) và xác minh giá trị SHA-256 của chúng trước khi xây dựng. Không bao giờ thay thế một gói tùy ý khi không có tạo phẩm ngược dòng được ghim.
- Mô-đun trình duyệt LiveKit và giấy phép của nó vẫn nằm trong thư mục nguồn công khai của plugin; kho lưu trữ npm `.tgz` dự phòng không được gửi đi.

Đây là những loại trừ phân phối nguồn, không phải những thay đổi đối với công cụ đang chạy.

## Hoàn thành gói ngoại tuyến

Bắt đầu với [đường dẫn nguồn công cộng](../../install/PUBLIC-BUILD.vi.md). Nó cung cấp các hình ảnh gốc công khai và các phần phụ thuộc thời gian chạy do nguồn xây dựng; không cần phải cài đặt nhà phát triển trước đó. Công thức hình ảnh phân lớp lịch sử không phải là điểm bắt đầu cài đặt mới.

Theo dõi [install/README.md](../../install/README.vi.md) để biết các bản dựng hình ảnh ứng dụng, công cụ máy chủ khách, gói máy chủ ngoại tuyến, bộ sưu tập nội dung và đóng gói cuối cùng. Công cụ mục tiêu không tìm nạp các phần phụ thuộc hoặc thay thế Docker/NVIDIA. Đặt đầu vào bản dựng cho cam kết nguồn thực tế của bạn, ID nội dung ARM64 OCI và đường dẫn nội dung sạch. Không yêu cầu IP, tài khoản, chứng chỉ hoặc khối lượng máy chủ phát triển. Trọng số mô hình và nội dung khách/thời gian chạy được lấy riêng biệt với các nguồn ngược dòng chính xác được xác định trong [comComponents.json](components.json) và các khóa kho lưu trữ. Bảo quản giấy phép của họ và thông báo nguồn cần thiết.

**Tính khả dụng của nguồn không phải là giấy phép phân phối lại nhị phân.** Hợp đồng gói ngoại tuyến hoàn chỉnh hiện tại bao gồm thời gian chạy Google Android; bằng chứng cài đặt riêng tư của nó không được phép phân phối GMS. Trình đóng gói hiện tại được giữ lại không thay đổi, nhưng gói như vậy không phải là bản tải xuống công khai được phê duyệt trừ khi có được các quyền đó. Phiên bản nhị phân công khai chỉ dành cho AOSP sẽ là một thay đổi về bao bì có phạm vi riêng biệt, không được thay thế âm thầm ở đây. Các tệp ISO Windows/Linux được cung cấp bởi mỗi người dùng; không có trạng thái tài khoản hoặc khách thử nghiệm đã cài đặt nào là đầu vào của bản dựng công khai.
