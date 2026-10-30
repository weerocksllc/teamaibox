<!-- doc-navigation:start -->
[English](RELEASING.md) · [简体中文](RELEASING.zh-CN.md) · [繁體中文](RELEASING.zh-TW.md) · [日本語](RELEASING.ja.md) · [한국어](RELEASING.ko.md) · [Français](RELEASING.fr.md) · [Deutsch](RELEASING.de.md) · [Español](RELEASING.es.md) · [Português](RELEASING.pt-BR.md) · [Русский](RELEASING.ru.md) · [العربية](RELEASING.ar.md) · [हिन्दी](RELEASING.hi.md) · [Bahasa Indonesia](RELEASING.id.md) · [Italiano](RELEASING.it.md) · [Türkçe](RELEASING.tr.md) · [Tiếng Việt](RELEASING.vi.md) · [ไทย](RELEASING.th.md)

[Team AI Box — README](../../README.vi.md)
<!-- doc-navigation:end -->

# Giải phóng ranh giới

## Hiện vật riêng biệt

1. **MIT ứng viên nguồn**: mã gốc, thông số kỹ thuật hiện tại, thông báo và công cụ xây dựng/kiểm tra đã được xem xét; không có lịch sử Git hoặc bằng chứng phòng thí nghiệm tư nhân.
2. **Tài liệu của bên thứ ba**: nguồn/mã nhị phân/mô hình ngược dòng chính xác có giấy phép và ghi công riêng của chúng. Nghĩa vụ nguồn Copyleft đi cùng với các tệp nhị phân.
3. **Gói công cụ ngoại tuyến hoàn chỉnh**: được xây dựng bởi `install/`; không được tự động cấp phép để phân phối lại công khai. Các thành phần GMS, HunyuanOCR, NVIDIA và giấy phép khách/chương trình cơ sở yêu cầu xem xét cụ thể về tạo phẩm. Không xuất bản gói riêng tư, gói mô hình hoặc hình ảnh đăng nhập dưới nhãn MIT.
4. **Trang web tiếp thị**: `website/`, bao gồm các mẫu bài viết, nội dung, nội dung thiết kế, phân tích và cấu hình triển khai, vẫn nằm trong kho lưu trữ GitHub riêng tư của `weerocksllc/teamaibox.com`. GitLab là kho lưu trữ lịch sử, không phải kho lưu trữ phát triển trang web. Trang web này không phải là một phần của việc phân phối nguồn sản phẩm công cộng. Giao diện người dùng trình duyệt thiết bị trong `apps/` vẫn là một phần của sản phẩm nguồn mở.

Các tập lệnh triển khai, khôi phục và ghi lại bằng chứng trong lịch sử trên một thiết bị không phải là công cụ sản phẩm có thể tái sử dụng. Chính sách phát hành không bao gồm các tập lệnh và ảnh chụp nhanh đã ngừng hoạt động; không khôi phục chúng từ kho lưu trữ riêng tư. Các công cụ được giữ lại yêu cầu các mục tiêu rõ ràng do nhà điều hành cung cấp thay vì máy chủ, tài khoản, vùng chứa hoặc tệp bằng chứng của nhà phát triển. Chạy quét nhạy cảm bổ sung cũng như Gitleaks: ID thiết bị, ID vùng chứa, hàm băm GSF và tên tài khoản cá nhân đang kiểm tra siêu dữ liệu ngay cả khi chúng không phải là thông tin đăng nhập có thể sử dụng được. Việc dọn dẹp lịch sử công khai yêu cầu sự cho phép rõ ràng của chủ sở hữu và không bao giờ được viết lại kho lưu trữ riêng tư hoặc thẻ phân phối của nó. Sau khi viết lại được ủy quyền, hãy sử dụng bản sao công khai mới thay vì hợp nhất lịch sử đã ngừng hoạt động trở lại kho lưu trữ được duy trì.

Kho lưu trữ phát triển nội bộ và các thẻ của nó vẫn còn nguyên. Lịch sử có thể truy cập của nó chứa các bản ghi triển khai cũ và nội dung SDK độc quyền đã ngừng hoạt động; nó không được công khai mà không thay đổi. Cây được xuất mới cung cấp điểm khởi đầu công khai mà không âm thầm viết lại lịch sử phân phối ban đầu.

## Chuẩn bị tại chỗ

Sử dụng **Gitleaks 8.30.1**, được tải xuống từ bản phát hành GitHub chính thức và xác minh tổng kiểm tra của nó. Công cụ kiểm tra không bao giờ cài đặt gói hệ thống hoặc tải dữ liệu lên. Đầu ra riêng tư được đưa vào `.runtime/open-source-audit/` bị bỏ qua, không phải PR công khai.

```sh
python3 tools/open_source_release.py baseline --output .runtime/open-source-audit/before.json
python3 tools/open_source_release.py scan --gitleaks /path/to/gitleaks --output .runtime/open-source-audit/review
python3 tools/open_source_sensitive.py --output .runtime/open-source-audit/project-review.json
python3 tools/open_source_inventory.py
python3 tools/open_source_release.py export --gitleaks /path/to/gitleaks --output .runtime/open-source-audit/source-candidate
```

Đầu ra phải là đường dẫn mới; các công cụ không bao giờ ghi đè lên các ứng cử viên trước đó. Xem xét các địa điểm đã được xử lý lại, không chỉ tính. Ghi lại các thông tin cố định tổng hợp, thông tin xác thực bootstrap công khai, thông tin nhận dạng sai và thông tin xác thực riêng tư thực tế/có thể có một cách riêng biệt. Quét mẫu không thể xác thực thông tin đăng nhập hoặc ảnh chụp màn hình OCR. Các tạo phẩm nhị phân bị loại trừ, không được khai báo là đã quét sạch. Nhà xuất khẩu nguồn chỉ thừa nhận các tệp đã biết về Git và thông tin đầu vào rõ ràng không bị theo dõi trong [release-policy.json](release-policy.json). Đầu vào mới chưa được theo dõi cần được xem xét. Nó từ chối các liên kết tượng trưng và truyền tải đường dẫn và phát ra các loại trừ SHA-256 cộng với mỗi tệp. `website/` luôn bị loại trừ, ngay cả khi được theo dõi hoặc liệt kê dưới dạng đầu vào không được theo dõi. Không bao giờ sao chép thư mục `.git` của kho lưu trữ riêng vào thanh toán công khai. Trước khi xuất bản, hãy xác minh cả cây và tất cả các cam kết công khai có thể truy cập đều không chứa tệp trang web; việc xóa các tập tin trong lần xác nhận sau này sẽ không xóa lịch sử cũ.

Kiểm tra bổ sung bao gồm thông điệp commit/tag có thể truy cập, thông tin đăng nhập dễ đoán được viết cố định trong mã, định danh thiết bị và địa chỉ môi trường phát triển. Dữ liệu kiểm thử không tự động được miễn kiểm tra: hãy giải thích vì sao mỗi fixture được giữ lại là dữ liệu tổng hợp. Có thể lưu các giá trị riêng tư đã biết trong một mảng JSON bên ngoài gồm các bản ghi `{id, value, word?}`, rồi truyền tệp bằng `--denylist`. Dùng ID không chứa thông tin nhạy cảm và giữ tệp ngoài thư mục mã nguồn. Báo cáo chỉ hiển thị vị trí và mã băm, không hiển thị giá trị. Nếu khớp một giá trị đã biết, kiểm tra sẽ thất bại. Dùng `--scope worktree` khi làm sạch; trước khi công bố, kiểm tra `--scope all` trong kho phát hành mới không có commit cha. Không công bố lịch sử cũ hoặc báo cáo kiểm tra riêng tư.

Mặc định duy nhất do quản trị viên cố ý của nhà máy là `admin / admin`; thay đổi nó trong quá trình triển khai. Các công cụ kiểm tra trình duyệt/triển khai phải nhận được thông tin xác thực tài khoản hiện có thông qua đầu vào cục bộ được bảo vệ. Các tài khoản thử nghiệm khói mới được tạo sử dụng thông tin xác thực ngẫu nhiên và bị vô hiệu hóa trong quá trình dọn dẹp. Việc dọn dẹp không thành công là một lần thử nghiệm thất bại, không phải là một lần chạy thành công. Việc chấm dứt quá trình đột ngột có thể ngăn cản việc dọn dẹp; các nhà khai thác phải đối chiếu các tài khoản tạm thời của họ sau khi bị gián đoạn. Không có tài liệu công khai nào khẳng định chứng chỉ kiểm tra hiện có giá trị.

Chỉ có điểm vào `install/` được duy trì là đường dẫn cài đặt thiết bị sạch. Đánh giá quyền sở hữu thành phần có trong [OWNERSHIP.md](OWNERSHIP.vi.md).

Không có lệnh nào ở đây đẩy Git, thay đổi khả năng hiển thị, viết lại lịch sử, xoay thông tin đăng nhập trực tiếp, thay đổi thiết bị hoặc cấp quyền phân phối lại cho bên thứ ba. Việc phát hành công khai yêu cầu một điểm đến công khai được lựa chọn rõ ràng và đánh giá tạo tác cuối cùng. Bảo quản `delivery-2026-10-22` trong kho lưu trữ riêng.
