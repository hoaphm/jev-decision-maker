# JEV hiệu quả phán đoán — pilot

Sinh lúc 2026-09-21T05:28:25.005Z từ `results.json` của batch `judgment` (run dir `<local>/jev-effective-results/run-GUwD9b`). Model chính `9router/cx/gpt-5.6-terra:high`; omp omp/18.2.7, bun 1.3.14. Nguồn credential: `omp-store-readonly-to-isolated-env` (không ghi giá trị); child điều trị resolve được credential: true. Harness: `<local>/jev-effective-runner.ts` hash `0c26083a48b9ff9b5687f16c9b5b14eb4cd40756ac780bf682b5d4d5359c1d12`.

## 1. Chức năng và giao thức

- Smoke (0 lượt model chính): **fail (the slash command did not answer without an agent turn)** — select 1 request / 1 câu hỏi / 1571 byte; score 0 request / 0 câu hỏi / 0 byte, 0 candidate được chấm. Đây là bằng chứng một batch score là **một** HTTP request, không phải suy ra từ số câu hỏi.
- Phiên có prompt: 0/12; request JEV: 2/32 (trần), 12 phiên (trần).
- **Batch dừng sớm:** smoke failed: the slash command did not answer without an agent turn
- Hai fixture là hai câu hỏi khác nhau: `diagnostic-selection` (select, negative control — bài rõ ràng thì không gọi tool là hành vi đúng) và `patch-shortlist` (score, 5 phương án một rubric).

## 2. Chất lượng tác vụ

| Fixture | Chế độ | Cặp | winner B | winner J | tool request J | selected | scored | deferred/uncertain | client failure |
|---|---|---|---|---|---|---|---|---|---|
| diagnostic-selection | select | 0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 | 0 |
| patch-shortlist | score | 0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 | 0 |
- diagnostic-selection: not exercised — tool có mặt nhưng không phiên nào gọi.
- patch-shortlist: not exercised — tool có mặt nhưng không phiên nào gọi.

## 3. Thời gian

| Fixture | Cặp | agentMs B | agentMs J | median tỉ lệ J/B | min–max | cặp nhanh hơn |
|---|---|---|---|---|---|---|
| diagnostic-selection | 0 | none | none | n/a | n/a–n/a | 0/0 |
| patch-shortlist | 0 | none | none | n/a | n/a–n/a | 0/0 |

- `agentMs` là thời gian phiên model, đã bao gồm mọi round-trip của arm điều trị; không có arm đối chứng 'buộc gọi tool rỗng' nên chưa tách được chi phí của chỉ thị so với chi phí của phán đoán.

## 4. Chi phí

| Fixture | Cặp | tổng cost B (USD) | tổng cost J (USD) | median tỉ lệ cost | cặp có đủ số liệu |
|---|---|---|---|---|---|
| diagnostic-selection | 0 | none | none | n/a | 0/0 |
| patch-shortlist | 0 | none | none | n/a | 0/0 |
- diagnostic-selection: main cost B none, điều trị none USD; JEV 0 request, latency none ms, cost none USD.
- patch-shortlist: main cost B none, điều trị none USD; JEV 0 request, latency none ms, cost none USD.
- Cùng mẫu số ở mọi tỉ lệ chi phí: **tổng cost của cả phiên** (model chính + mọi request JEV). Null giữ nguyên null — thiếu một thành phần thì tổng là unknown, không đổi thành 0.
- Trạng thái cost toàn batch: `unknown`.

## 5. Kết luận và giới hạn

- Collection: chưa hoàn tất (smoke failed: the slash command did not answer without an agent turn).
- Chức năng: không đạt (smoke + đăng ký + cách ly).
- Lợi ích đo được: không có / không đo được — xem bảng 3 và 4 theo từng trục riêng.
- n=3 cặp/fixture: mô tả, không phải kiểm định. Không suy ra calibration, không so chéo với batch cũ (runtime khác), và không dùng fixture select làm bằng chứng JEV giải được chẩn đoán nhiều bước.
- Private grader chạy ngoài workspace và hash của nó được đối chiếu trước/sau từng phiên; oracle không nằm trong prompt, tool input hay bất kỳ file nào agent đọc được.
