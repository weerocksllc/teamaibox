<!-- doc-navigation:start -->
[English](SOURCE-PRIVACY.md) · [简体中文](SOURCE-PRIVACY.zh-CN.md) · [繁體中文](SOURCE-PRIVACY.zh-TW.md) · [日本語](SOURCE-PRIVACY.ja.md) · [한국어](SOURCE-PRIVACY.ko.md) · [Français](SOURCE-PRIVACY.fr.md) · [Deutsch](SOURCE-PRIVACY.de.md) · [Español](SOURCE-PRIVACY.es.md) · [Português](SOURCE-PRIVACY.pt-BR.md) · [Русский](SOURCE-PRIVACY.ru.md) · [العربية](SOURCE-PRIVACY.ar.md) · [हिन्दी](SOURCE-PRIVACY.hi.md) · [Bahasa Indonesia](SOURCE-PRIVACY.id.md) · [Italiano](SOURCE-PRIVACY.it.md) · [Türkçe](SOURCE-PRIVACY.tr.md) · [Tiếng Việt](SOURCE-PRIVACY.vi.md) · [ไทย](SOURCE-PRIVACY.th.md)

[Team AI Box — README](../../README.vi.md)
<!-- doc-navigation:end -->

# Ranh giới bảo mật nguồn công cộng

Kho lưu trữ sản phẩm công cộng là một ảnh chụp nhanh nguồn mới, không phản ánh lịch sử phát triển tư nhân. Trang web tiếp thị có kho lưu trữ riêng và không được đưa vào đây.

## Tài liệu đã bị xóa

- Đã sửa lỗi tên và mật khẩu tài khoản thử nghiệm triển khai cũng như danh sách tài khoản cá nhân.
- Trình bao bọc và tập lệnh triển khai/khôi phục một thiết bị ghi lại danh tính thiết bị lịch sử hoặc kết quả được xác nhận từ bằng chứng riêng tư.
- Địa chỉ máy chủ thực tế, thư mục chính, nhận dạng container/thiết bị và ảnh chụp nhanh lịch sử bảo trì. Các thử nghiệm được giữ lại sử dụng đồ đạc tổng hợp rõ ràng; các công cụ vận hành được duy trì yêu cầu đầu vào mục tiêu rõ ràng.
- Đĩa khách, trạng thái đăng nhập Android, phiên trình duyệt, gói cài đặt, trọng lượng mô hình và bằng chứng riêng tư nằm ngoài nguồn phân phối công khai.

Các thẻ lưu trữ riêng tư và phân phối ban đầu vẫn còn nguyên. Không có gì trong quá trình dọn dẹp nguồn này làm thay đổi tài khoản công cụ, dữ liệu khách, dịch vụ đang chạy hoặc triển khai trang web. Giá trị mặc định của nhà máy `admin / admin` được cố ý giữ lại; nó không phải là thông tin xác thực riêng tư. Quản trị viên phải thay đổi nó trước khi tiếp xúc.

## Xem xét và xác minh

Xem lại cả cây công việc và mọi cam kết/thẻ có thể truy cập trong kho lưu trữ đang được xuất bản. Sử dụng Gitleaks cộng với `tools/open_source_sensitive.py`; không một mình là bằng chứng cho thấy không có mật khẩu entropy thấp hoặc siêu dữ liệu cá nhân. So sánh các giá trị riêng tư cũ đã được xác nhận bằng cách sử dụng danh sách từ chối riêng tư bên ngoài, không bao giờ sử dụng lịch thi đấu đã cam kết. Xem xét các phát hiện còn lại một cách riêng lẻ, bao gồm cả các tệp thử nghiệm.

Kiểm tra dọn dẹp là chính sách nguồn, hồi quy tổng hợp, kiểm tra cấu hình và cú pháp. Họ không đăng nhập bằng thông tin đăng nhập được phát hiện, cài đặt lại hộp hoặc lặp lại việc chấp nhận sản phẩm. Bản sửa lỗi đóng gói API trước đó (bao gồm nguồn giao diện người dùng được chia sẻ và kiểm tra điểm nhập chỉ nhập) vẫn còn trong nguồn.

Bản sao mới không được nhập các cam kết, giới thiệu hoặc thẻ đã ngừng hoạt động. Việc xóa kho lưu trữ sẽ không thu hồi các bản sao đã được người khác tải xuống. Không quá trình quét nào có thể chứng minh rằng thông tin xác thực không xác định chưa bao giờ được sao chép; thông tin xác thực đã được sử dụng thực sự phải được nhà điều hành của nó luân chuyển. Việc dọn dẹp này không tuyên bố đã xoay nó.

Xem [RELEASING.md](RELEASING.vi.md) để biết hướng dẫn xem xét và xuất nguồn và [BUILDING.md](BUILDING.vi.md) để biết các điều kiện tiên quyết của bản dựng và nội dung thu được riêng biệt.
