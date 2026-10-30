<!-- doc-navigation:start -->
[English](SOURCE-INSTALL.md) · [简体中文](SOURCE-INSTALL.zh-CN.md) · [繁體中文](SOURCE-INSTALL.zh-TW.md) · [日本語](SOURCE-INSTALL.ja.md) · [한국어](SOURCE-INSTALL.ko.md) · [Français](SOURCE-INSTALL.fr.md) · [Deutsch](SOURCE-INSTALL.de.md) · [Español](SOURCE-INSTALL.es.md) · [Português](SOURCE-INSTALL.pt-BR.md) · [Русский](SOURCE-INSTALL.ru.md) · [العربية](SOURCE-INSTALL.ar.md) · [हिन्दी](SOURCE-INSTALL.hi.md) · [Bahasa Indonesia](SOURCE-INSTALL.id.md) · [Italiano](SOURCE-INSTALL.it.md) · [Türkçe](SOURCE-INSTALL.tr.md) · [Tiếng Việt](SOURCE-INSTALL.vi.md) · [ไทย](SOURCE-INSTALL.th.md)

[Team AI Box — README](../README.vi.md)
<!-- doc-navigation:end -->

# Cài đặt từ bản sao công khai

Điểm vào này chuẩn bị các đầu vào công khai cần thiết, xây dựng hình ảnh ứng dụng và tạo ra một gói hoàn chỉnh trước khi cài đặt nó. Tiến độ xây dựng có thể tiếp tục; chỉ có kết quả sẵn sàng cài đặt cuối cùng mới cho biết thiết bị đã được cài đặt. Tải về hoặc preflight thành công một mình thì không.

Giữ các mô hình đã tạo, hình ảnh vùng chứa, gói cài đặt, bản ghi kiểm tra và thông tin xác thực bên ngoài kho lưu trữ. Tính khả dụng của gương của bên thứ ba không được đảm bảo; bộ đệm di động và gói ngoại tuyến đã được xác minh được mô tả bên dưới.

Trên DGX Spark mới với Ubuntu 24.04, Docker/Compose, NVIDIA và KVM đang hoạt động, hãy sao chép kho lưu trữ công cộng và chạy từ thư mục gốc của nó:

```sh
git clone https://github.com/weerocksllc/teamaibox.git
cd teamaibox
sudo bash install/from-source.sh
```

Đối với mạng ở Trung Quốc đại lục nơi không thể truy cập được điểm cuối hình ảnh/mô hình ngược dòng, hãy sử dụng cùng một điểm truy cập với các nguồn tải xuống trong khu vực:

```sh
sudo bash install/from-source.sh --region cn
```

Đây là **bản dựng nguồn trực tuyến, sau đó là cài đặt ngoại tuyến**, không phải bản dựng nguồn ngoại tuyến. Nó tự động chuẩn bị các công cụ xây dựng còn thiếu, tải xuống sáu đầu vào mô hình, xây dựng và lắp ráp Android và tất cả hình ảnh ứng dụng, định lượng hai mô hình nguồn, thu thập các gói chương trình cơ sở/máy chủ, tạo gói ngoại tuyến hoàn chỉnh và chạy trình cài đặt hiện có. Nó không thay thế Docker/NVIDIA, khởi động lại daemon Docker, xóa cài đặt hiện có hoặc thay đổi cài đặt định tuyến máy chủ, DNS hoặc VPN. Mô hình, trạng thái đăng nhập của khách và trang web tiếp thị riêng không được lấy từ bản cài đặt khác.

Không gian làm việc mặc định là `/var/tmp/teamaibox-source-build`; bộ nhớ đệm tải xuống và nhật ký theo từng giai đoạn tồn tại ở đó, bên ngoài bản sao. Cài đặt mặc định là `/srv/teamaibox/installation`. Mong đợi lượt tải xuống lớn và vài trăm GB sử dụng đĩa tạm thời. Việc tải mô hình và lượng tử hóa GPU có thể mất nhiều thời gian; không có thời gian hoàn thành cố định được hứa hẹn.

## Tiếp tục cài đặt và kiểm tra trạng thái

Nếu bị gián đoạn, **chạy lại lệnh tương tự**. Giữ không gian làm việc. Bản dựng đang chạy sẽ loại trừ người viết khác; các tập tin và hình ảnh giai đoạn đã hoàn thành được xác minh trước khi sử dụng lại. Những lần thử thất bại vẫn có sẵn để chẩn đoán, trong khi lần thử tiếp theo chỉ chạy giai đoạn thất bại. Phạm vi byte mô hình và các tệp đã xác minh được giữ lại. `state.json` xác định giai đoạn hiện tại và thư mục nhật ký của nó. Tải xuống mô hình chính thức sử dụng đồng thời tệp/phạm vi giới hạn; các nguồn khu vực sử dụng đồng thời thận trọng để giảm giới hạn tốc độ. Báo cáo tiến trình byte trên mỗi tệp được chuyển hoặc sử dụng lại phạm vi riêng biệt với xác minh hàm băm cuối cùng của nhà xuất bản. Quá trình biên dịch công cụ khách cũng hoạt động trong một dịch vụ hệ thống không có trang chủ đăng nhập: nó tạo ra các bộ nhớ đệm bản dựng riêng biệt bên ngoài nội dung cài đặt kết quả.

Những thay đổi về nguồn yêu cầu một `--work-dir` mới; sử dụng lại bộ nhớ đệm tải xuống bằng `--cache-dir /path/to/public-cache`. Dấu vân tay nguồn ngăn chặn việc âm thầm kết hợp các đầu ra từ các mã khác nhau. Cài đặt hiện tại không phải là lời mời đặt lại: chỉ cài đặt cùng gói của không gian làm việc này mới có thể tiếp tục; các cài đặt khác phải sử dụng quá trình nâng cấp của chúng.

Các chế độ hữu ích:

```sh
sudo bash install/from-source.sh --check
sudo bash install/from-source.sh --region cn --download-models-only
sudo bash install/from-source.sh --region cn --build-only
```

`--check` ở chế độ chỉ đọc và không khẳng định việc tải xuống sẽ thành công. Chỉ tải xuống và chỉ xây dựng rõ ràng không yêu cầu mức độ sẵn sàng được cài đặt.

## Nguồn khu vực và tính toàn vẹn

Chế độ Trung Quốc sử dụng `https://hf-mirror.com` để chuyển mô hình và `https://docker.m.daocloud.io` cho đầu vào Docker Hub được ghim tổng hợp. Đây là bản sao của bên thứ ba, không phải dịch vụ do Weerocks hoặc nhà xuất bản mô hình điều hành. Cam kết Git mô hình được ghim bởi hồ sơ sản phẩm; Cây Git đã được xác minh và các con trỏ LFS của nó thiết lập kích thước tệp và giá trị băm dự kiến. Chỉ riêng phản hồi API của máy nhân bản không thể thiết lập được sự tin cậy. Docker xác minh các bản tóm tắt của bảng kê khai/lớp được ghim. Các thẻ đã bỏ ghim không được tự động chuyển hướng (công cụ xây dựng Go có khóa thông báo rõ ràng). Hình ảnh NVIDIA vẫn còn trong sổ đăng ký của nhà xuất bản. Xác minh TLS vẫn được bật và không có mã thông báo tài khoản nào được gửi tới máy nhân bản mô hình.

Bạn có thể chọn nguồn gốc HTTPS của riêng mình bằng cách sử dụng `--model-endpoint` and `--registry-mirror`. Giá trị điểm cuối không được bao gồm thông tin xác thực hoặc tham số truy vấn. Trình bao bọc Docker có phạm vi chỉ áp dụng cho quá trình xây dựng này, không áp dụng cho trình nền hệ thống hoặc các dự án khác. Kho lưu trữ giấy phép và siêu dữ liệu SDK vẫn đến từ các nhà xuất bản HTTPS có thẩm quyền của họ; một tấm gương không thể phát minh ra hàm băm.

Gương có thể bị giới hạn tỷ lệ hoặc không có sẵn. Tải xuống mô hình chạy đồng thời có giới hạn và tôn trọng thời gian hồi chiêu. Không có tập lệnh nào có thể đảm bảo khả năng kết nối tới mọi luồng ngược trên mọi mạng. Nếu cả hai tuyến đều không khả dụng, hãy chuẩn bị các bản tải xuống hoặc gói hoàn chỉnh trên một máy tương thích có thể truy cập và sao chép chúng qua:

- `--download-models-only --cache-dir <public-cache>` chuẩn bị các tệp mô hình đã được xác minh và bộ nhớ đệm có thể tiếp tục. Sao chép thư mục đó rồi chuyển nó với `--cache-dir` trên mục tiêu. Mỗi mô hình được sử dụng lại đều được kiểm tra dựa trên danh tính được ghim của nó. Bộ đệm này **không phải** là gói cài đặt ngoại tuyến đầy đủ.
- `--build-only` chuẩn bị gói đầy đủ để cài đặt ngoại tuyến. Sao chép tar và tổng kiểm tra của nó, xác minh và giải nén, sau đó chạy `sudo ./install.sh` bên trong nó. Đây là tuyến máy chủ bị ngắt kết nối đáng tin cậy; nó không yêu cầu VPN trên mục tiêu hoặc quyền truy cập vào hộp phát triển.

Không bao giờ sao chép thư mục dữ liệu Docker trực tiếp, đĩa khách, hồ sơ trình duyệt, cơ sở dữ liệu tài khoản, thông tin xác thực hoặc bộ đệm riêng để thay thế cho đầu vào công khai. Không tắt tính năng tổng kiểm tra hoặc chấp nhận trang đăng nhập/thử thách dưới dạng tệp mô hình.

## Cấp phép và sử dụng lần đầu

Xem lại `THIRD_PARTY_NOTICES.md`, điều khoản SDK Android và giấy phép mô hình riêng lẻ trước khi xây dựng. Việc tải xuống các thành phần của bên thứ ba không biến chúng thành nội dung MIT hoặc cấp giấy chứng nhận/quyền phân phối lại của Google. Phương tiện ISO Windows/Linux vẫn do người dùng cung cấp. Thông tin đăng nhập ban đầu vẫn là `admin/admin`; thay đổi nó trước khi tiếp xúc với thiết bị. Trình cài đặt hiện tại tạo ra thông tin xác thực dịch vụ độc lập và báo cáo mức độ sẵn sàng thực tế.

Sau khi hoàn thành, hãy mở `https://<BOX_LAN_IP>/` trên cùng mạng LAN; thay thế địa chỉ mạng vật lý hiện tại của Spark, không phải cầu nối Docker hoặc địa chỉ VPN. Bản ghi tiến trình xây dựng bản ghi `state.json` của không gian làm việc nguồn. `/srv/teamaibox/installation/readiness.json` đã cài đặt ghi lại các lần kiểm tra cài đặt. Việc biên dịch thành công hay kiểm tra tình trạng vùng chứa nghe đều không thay thế được hoạt động từ đầu đến cuối hiển thị của ứng dụng.

Thời gian chạy truyền phải chứa bộ thu UxPlay, các tệp thực thi khám phá D-Bus và Avahi riêng tư cũng như các plugin phương tiện của nó. Bản dựng hình ảnh công khai cuối cùng sẽ kiểm tra các tệp thực thi này; một thư viện khách hàng thôi là không đủ. Bản cài đặt mới sẽ đăng ký proxy và cổng máy tính để bàn với các phần phụ thuộc không gian tên mạng API khác để các bản nâng cấp API được nhóm có thể giữ lại đường dẫn kết nối máy tính để bàn. Không chỉ tạo lại một tập hợp con của nhóm đó trong quá trình bảo trì.
