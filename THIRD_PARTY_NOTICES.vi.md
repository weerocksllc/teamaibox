<!-- doc-navigation:start -->
[English](THIRD_PARTY_NOTICES.md) · [简体中文](THIRD_PARTY_NOTICES.zh-CN.md) · [繁體中文](THIRD_PARTY_NOTICES.zh-TW.md) · [日本語](THIRD_PARTY_NOTICES.ja.md) · [한국어](THIRD_PARTY_NOTICES.ko.md) · [Français](THIRD_PARTY_NOTICES.fr.md) · [Deutsch](THIRD_PARTY_NOTICES.de.md) · [Español](THIRD_PARTY_NOTICES.es.md) · [Português](THIRD_PARTY_NOTICES.pt-BR.md) · [Русский](THIRD_PARTY_NOTICES.ru.md) · [العربية](THIRD_PARTY_NOTICES.ar.md) · [हिन्दी](THIRD_PARTY_NOTICES.hi.md) · [Bahasa Indonesia](THIRD_PARTY_NOTICES.id.md) · [Italiano](THIRD_PARTY_NOTICES.it.md) · [Türkçe](THIRD_PARTY_NOTICES.tr.md) · [Tiếng Việt](THIRD_PARTY_NOTICES.vi.md) · [ไทย](THIRD_PARTY_NOTICES.th.md)

[Team AI Box — README](README.vi.md)
<!-- doc-navigation:end -->

# Phạm vi giấy phép và thông báo của bên thứ ba

Bản quyền © 2026 Weerocks LLC. Giấy phép gốc [MIT](LICENSE) bao gồm mã và tài liệu gốc Team AI Box được chủ sở hữu của nó ủy quyền. Nó không cấp phép lại mã của bên thứ ba, các tệp ngược dòng được sao chép/sửa đổi, các phần phụ thuộc, kiểu máy, chương trình cơ sở, hệ điều hành, phông chữ hoặc hình ảnh. Các tệp bản quyền, GIẤY PHÉP và THÔNG BÁO hiện có được ưu tiên cho tài liệu tương ứng của chúng. Siêu dữ liệu gói `license: MIT` đề cập đến mã gốc của gói đó, không phải mọi thứ có trong hình ảnh được triển khai. `private: true` được giữ lại để tránh vô tình xuất bản đăng ký gói; nó không thu hồi khoản trợ cấp MIT.

## Hàng tồn kho

[Kiểm kê thành phần](docs/open-source/components.json) có thể đọc được bằng máy ghi lại các phiên bản hoặc nguồn phiên bản, bằng chứng cấp phép, phạm vi phân phối lại và các nghĩa vụ nhị phân chưa được giải quyết. [Kho lưu trữ phụ thuộc](docs/open-source/dependencies.json) được tạo từ tệp khóa, siêu dữ liệu phụ thuộc đã cài đặt, mô-đun Go và tệp yêu cầu Python. Siêu dữ liệu giấy phép bị thiếu không xác định rõ ràng, không được giả định là MIT. Tái tạo nó bằng `python3 tools/open_source_inventory.py`.

| Thành phần/vật liệu | Ranh giới giấy phép | Yêu cầu phân phối |
| --- | --- | --- |
| Bộ thu UxPlay và `deploy/casting/uxplay-*.patch` | GPL-3.0-only | Giữ lại GPL, thông báo, nguồn ngược dòng chính xác, các bản vá và tập lệnh xây dựng với bất kỳ tệp nhị phân nào của máy thu; chỉ liên kết ngược dòng là không đủ để phát hành nhị phân. |
| gst-plugins-rs / `gst-webrtc-*.patch` | MPL-2.0 | Giữ lại các thông báo và cung cấp các tệp nguồn được sửa đổi. |
| GStreamer | LGPL và giấy phép plugin riêng lẻ | Kiểm tra bộ plugin thực tế và thực hiện các nghĩa vụ tương ứng. |
| SDK trình duyệt/máy chủ LiveKit | Apache-2.0 | Giữ bản quyền, giấy phép và THÔNG BÁO hiện hành. |
| Mực nang / AOSP | Apache-2.0 và giấy phép mỗi tệp, bao gồm hạt nhân GPL | Bảo lưu các thông báo ngược dòng và nguồn tương ứng có thể áp dụng. AOSP không bao gồm giấy phép dịch vụ của Google. |
| Trình điều khiển QEMU / Linux / EDK II / virtio | Giấy phép theo từng dự án và từng tệp | Kiểm tra bản dựng nhị phân, chương trình cơ sở và trình điều khiển thực tế; không gắn nhãn chung cho MIT. |
| Guacamole | Apache-2.0 | Giữ nguyên GIẤY PHÉP và THÔNG BÁO được sao chép bởi Dockerfile plugin máy tính. |
| Cây phụ thuộc Node/React/Vite và JS | Giấy phép theo gói | Giữ nguyên các thông báo phụ thuộc khi phân phối đầu ra theo gói. |
| Gói hệ điều hành PostgreSQL và container | PostgreSQL / mỗi gói | Bao gồm các bản ghi giấy phép gói đã cài đặt trong bản phát hành nhị phân. |
| PyMuPDF / MuPDF được OCR sử dụng | AGPL-3.0-or-later hoặc giấy phép thương mại | Dịch vụ/phân phối nhân viên OCR kết hợp không bao trùm MIT; tuân thủ nghĩa vụ AGPL hoặc có được quyền thương mại. Mã gốc có thể giữ lại cấp MIT. |
| Tài sản mô hình Qwen / LMT / Whisper / FLUX | Điều khoản của mô hình chính xác | Các mô hình tách biệt với nguồn cấp MIT. Các thuật ngữ FLUX **4B** không được thay thế cho một mẫu FLUX khác. |
| Trọng lượng HunyuanOCR | Giấy phép cộng đồng Tencent Hunyuan | Giấy phép mẫu có điều kiện; xem xét các điều khoản về người nhận, lãnh thổ, cách sử dụng, ghi công và phân phối lại cho mỗi bản phát hành. |
| Phần mềm NVIDIA | NVIDIA và bao gồm các điều khoản của bên thứ ba | Cài đặt Docker/NVIDIA máy chủ hiện tại không được phân phối lại bởi gói nguồn này. Các thư viện CUDA/container đi kèm vẫn cần được xem xét riêng. |
| Dịch vụ di động của Google / Cửa hàng Play | Độc quyền | Không phải là một phần của ứng cử viên nguồn công cộng. Mã tích hợp thời gian chạy không cấp quyền phân phối hình ảnh GMS. |
| Phương tiện cài đặt Windows, đĩa khách, tài khoản | Không được bảo hiểm | Người dùng cung cấp giấy phép và phương tiện ISO được ủy quyền. Không bao giờ gửi đĩa VM thử nghiệm hoặc trạng thái khách đã đăng nhập. |
| SDK ViKey đã ngừng hoạt động | Độc quyền / không có trợ cấp công cộng được thành lập | SDK bị xóa khỏi nguồn hoạt động; Các cam kết lịch sử riêng tư và các bản sao SDK được giữ lại không được xuất bản. Không cần khóa USB. |

Thông báo truyền chính xác vẫn còn trong [NOTICE.v4.txt](deploy/legal/airplay-compatible/NOTICE.v4.txt). Thông báo vận chuyển của ADB vẫn được giữ bên cạnh điện thoại khách hàng. Không loại bỏ chúng trong khi thu nhỏ hoặc đóng gói. Bản thân việc cách ly vùng chứa không hủy bỏ nghĩa vụ copyleft. Phân tích phân phối phụ thuộc vào tạo tác kết hợp thực tế.

## Thương hiệu và cộng tác viên

MIT cấp quyền bản quyền chứ không cấp quyền nhãn hiệu hoặc chứng thực. Team AI Box và tên/logo Weerocks không được ngụ ý hỗ trợ chính thức cho một sản phẩm đã sửa đổi. NVIDIA, DGX Spark, Android, Google Play, Windows và Apple/AirPlay thuộc về chủ sở hữu tương ứng của chúng. Khả năng tương thích không phải là chứng nhận.

Siêu dữ liệu của tác giả địa phương là bản kiểm kê chứ không phải bằng chứng về việc chuyển nhượng bản quyền. Các danh mục quyền sở hữu đã xem xét được ghi lại trong [OWNERSHIP.md](docs/open-source/OWNERSHIP.vi.md). Sự ủy quyền của chủ dự án áp dụng cho những đóng góp ban đầu của nó; những người đóng góp chỉ được gửi tác phẩm mà họ được quyền cấp phép. Ghi công bị nghi ngờ bị thiếu: teamaibox@weerocks.llc.
