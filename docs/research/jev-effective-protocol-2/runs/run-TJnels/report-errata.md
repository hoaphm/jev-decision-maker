# Errata của báo cáo — run-TJnels (Stage 1, protocol v2)

Không con số đo nào thay đổi. Hai lỗi dưới đây nằm ở **phần in**, không ở logic đã chạy.

## 1. Thanh dừng in sai một đơn vị

- `report.md` (bản gốc) in "dừng nếu hạng mục ≤ **18**/30", trong khi `protocol.md` §2.3 và `METRIC_RULES` đóng băng **≤ 19/30**. Nguyên nhân: `stopItems = Math.floor(forks * 0.633)` = 18.
- Sửa: `Math.round(forks * 19 / 30)` = 19, suy thẳng từ tỉ lệ đã đóng băng.
- **Không đổi phán quyết**: hạng mục 11/30 ≤ 18 < 19, nên cả hai cách tính đều dẫn tới "dừng — không chi Stage 2". Một kết quả 19/30 trong tương lai mới là ca mà lỗi này gây khác biệt (doc nói dừng, code cũ nói inconclusive) — đó là lý do nó phải sửa, không phải vì lần chạy này.

## 2. Danh sách call lỗi bị gán sai lớp

- `report.md` in "Lỗi authoring (`invalid_input`…): **0** — F3:score:invalid_response", tức một lỗi **client** được liệt kê ngay sau nhãn **authoring**. Nguyên nhân: một mảng `failedCalls` dùng chung cho cả hai lớp.
- Sửa: tách thành `clientFailureCalls` và `authoringCalls` ngay tại nguồn, mỗi tên nằm cạnh đúng con số của nó; verdict cũng in đúng danh sách theo từng nhánh.

## Truy xuất

- `results.json` **không đổi**: `22cb1aa19e3658f0790d03e05b453c1d8e370f4fa040f22e057298bbca6c158b`. Mọi hàng bảng của `report.md` và `report-final.md` **giống hệt nhau** (đã kiểm bằng diff) — chỉ dòng prose khác.
- `report.md` (**ad4c855285a6f2875189b23d332fcdfef632e93321c9253b0324554498b59ec8**) là bản gốc do lần chạy sinh ra, giữ nguyên làm bằng chứng.
- `report-final.md` (**a3f60c38f6ad23404b7c7c267844a0c8f80aba01691767d08f494cd4eb3c7eb6**) là bản có chữ đúng; đây là bản **có thẩm quyền** khi đọc.
- `freeze.json` của lần chạy vẫn ghi hash runner **trước** khi sửa, đúng như đã thực thi. Hash runner sau khi sửa được ghi trong `docs/research/jev-effective-runs/attempts.md` kèm lý do.
- `report-final.md` cố ý **không** in lại thanh dừng: lần chạy này không lưu trường `thresholds` (ra đời sau nó), nên mọi con số ngưỡng trong bản cuối đều lấy nguyên văn từ note đã lưu — render không được phép tính lại luật của một lần chạy cũ.

## 3. Một bản render trung gian đã bị xoá

Tồn tại một `report-fixed.md` là bản render **giữa hai lần sửa**: nó vẫn mang đúng mâu thuẫn mà errata này mô tả (thanh dừng tính lại `≤ 19/30` nằm trên note đã lưu `≤ 18`). Nó không có claim thẩm quyền nào và dễ khiến người đọc sau tưởng đó là bản cuối, nên **đã bị xoá**, và việc xoá được ghi ở đây thay vì im lặng.

Còn lại hai bản, đúng như mục "Truy xuất": `report.md` (bản gốc của lần chạy) và `report-final.md` (bản có thẩm quyền, render chỉ-đọc sau khi sửa).
