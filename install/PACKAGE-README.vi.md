<!-- doc-navigation:start -->
[English](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.en.md) · [简体中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.md) · [繁體中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.zh-TW.md) · [日本語](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ja.md) · [한국어](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ko.md) · [Français](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.fr.md) · [Deutsch](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.de.md) · [Español](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.es.md) · [Português](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.pt-BR.md) · [Русский](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ru.md) · [العربية](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ar.md) · [हिन्दी](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.hi.md) · [Bahasa Indonesia](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.id.md) · [Italiano](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.it.md) · [Türkçe](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.tr.md) · [Tiếng Việt](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.vi.md) · [ไทย](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.th.md)

[Team AI Box — README](https://github.com/weerocksllc/teamaibox/blob/main/README.vi.md)
<!-- doc-navigation:end -->

# gói cài đặt ngoại tuyến Team AI Box

Giấy phép cho mã gốc nằm trong gói `LICENSE`. Các thành phần của bên thứ ba giữ lại giấy phép ban đầu của chúng; xem `THIRD_PARTY_NOTICES.md` and `docs/open-source/components.json`. MIT không cấp thêm quyền phân phối lại cho các dịch vụ của Google, Windows, trọng lượng mẫu hoặc thương hiệu của bên thứ ba. Việc vượt qua kiểm tra tính toàn vẹn của gói không thiết lập quyền phân phối lại cho mọi thành phần.

Gói này dành cho DGX Spark mới duy trì hệ thống Linux tương thích của nhà máy. Nó sử dụng môi trường GPU Docker, Compose và NVIDIA hiện có mà không thay thế chúng hoặc định dạng ổ đĩa hệ thống.

## Cài đặt

Xác minh bản lưu trữ bằng tệp `.sha256` đi kèm, sau đó giải nén nó:

```sh
sha256sum -c teamaibox-<releaseId>-linux-arm64.tar.sha256
tar -xf teamaibox-<releaseId>-linux-arm64.tar
cd teamaibox-<releaseId>-linux-arm64
sudo ./install.sh
```

Cài đặt thông thường không cần truy cập internet công cộng cũng như không cần chỉnh sửa thủ công các biến môi trường. Trình cài đặt cung cấp các công cụ đi kèm cần thiết, tạo cấu hình cục bộ độc lập, khởi tạo cơ sở dữ liệu mới và khởi động các dịch vụ. Việc tải mô hình ban đầu có thể mất thời gian; chỉ báo tải không xác nhận việc cài đặt thành công.

Chạy `sudo ./install.sh --check` để kiểm tra môi trường và gói mà không cần cài đặt. `./install.sh --verify-package` chỉ kiểm tra nội dung gói và cũng có thể chạy trên máy trạm đóng gói. Sử dụng `--installation-root /dedicated/path/installation` để chỉ định gốc cài đặt mới; không bao giờ trỏ nó vào dữ liệu hiện có.

## Gián đoạn và dữ liệu hiện có

Sau khi xảy ra lỗi hoặc gián đoạn, hãy giải quyết sự cố được báo cáo và lặp lại lệnh ban đầu. Không xóa thư mục cài đặt. Trình cài đặt giữ nguyên danh tính và dữ liệu mà nó tạo ra. Việc chạy lại bản cài đặt hoàn chỉnh cùng phiên bản chỉ kiểm tra trạng thái của nó. Các phiên bản khác sử dụng đường dẫn nâng cấp chính thức, không xóa và cài đặt lại. Không có tùy chọn ghi đè bắt buộc.

## Lần sử dụng đầu tiên

Mở địa chỉ HTTPS tại IP hiện tại của thiết bị và đăng nhập:

- Tên người dùng quản trị viên: `admin`
- Mật khẩu ban đầu: `admin`

Trình cài đặt tự động tạo quản trị viên này; không cần trích xuất mã thông báo thiết lập hoặc đăng ký thủ công. Mật khẩu ban đầu được công khai và đơn giản: thay đổi mật khẩu trong phần quản lý người dùng trước khi giao/sử dụng. Người dùng thông thường không có tài khoản mặc định và được quản trị viên tạo. Điều này chỉ áp dụng cho cơ sở dữ liệu tài khoản trống; tiếp tục, chạy lại, khởi động lại và nâng cấp không bao giờ đặt lại tài khoản hoặc mật khẩu hiện có về mặc định. Mã khôi phục quản trị viên được tạo độc lập được lưu trữ trong thư mục gốc cài đặt tại `secrets/initial-owner-recovery.json`, chỉ có root mới có thể đọc được. Không bao giờ gửi mã khôi phục tới các cuộc trò chuyện, yêu cầu hoặc nhật ký công khai. Các cài đặt hiện tại không tạo hoặc thay thế mã khôi phục. Đối với chứng chỉ HTTPS được cấp cục bộ, hãy định cấu hình độ tin cậy của trình duyệt theo hướng dẫn CA của quản trị viên. Tên trong chứng chỉ không đảm bảo độ phân giải LAN DNS/mDNS. Chứng chỉ công khai CA cục bộ thường ở `/srv/teamaibox/installation/https/ca.crt`. Chỉ phân phối chứng chỉ công khai đó, không bao giờ phân phối khóa riêng bên cạnh nó.

Quá trình cài đặt không bao gồm các máy ảo, trạng thái đăng nhập Google hoặc tệp người dùng hiện có. Người dùng tải lên ISO Windows/Linux hoặc chọn chúng từ drive nhóm, sau đó tự cài đặt hệ thống khách. Google Play và các API bên ngoài yêu cầu quyền truy cập Internet và không được bao gồm trong lời hứa khả dụng ngoại tuyến.

Văn bản giấy phép thành phần được giữ lại cùng với tài nguyên phát hành của chúng. Bản quyền © Weerocks LLC. Liên hệ: teamaibox@weerocks.llc.
