# JEV hiệu quả phán đoán — pilot

Sinh lúc 2026-09-21T05:35:08.261Z từ `results.json` của batch `judgment` (run dir `<local>/jev-effective-results/run-TLHblq`). Model chính `9router/cx/gpt-5.6-terra:high`; omp omp/18.2.7, bun 1.3.14. Nguồn credential: `omp-store-readonly-to-isolated-env` (không ghi giá trị); child điều trị resolve được credential: true. Harness: `<local>/jev-effective-runner.ts` hash `737617cf580fdb03b8a501bbd1e32c673460ed443ad72db41c63bc355b221917`.

## 1. Chức năng và giao thức

- Smoke (0 lượt model chính): **pass** — select 1 request / 1 câu hỏi / 1571 byte; score 1 request / 5 câu hỏi / 5377 byte, 5 candidate được chấm. Đây là bằng chứng một batch score là **một** HTTP request, không phải suy ra từ số câu hỏi.
- Phiên có prompt: 12/12; request JEV: 3/32 (trần), 12 phiên (trần).
- Hai fixture là hai câu hỏi khác nhau: `diagnostic-selection` (select, negative control — bài rõ ràng thì không gọi tool là hành vi đúng) và `patch-shortlist` (score, 5 phương án một rubric).

## 2. Chất lượng tác vụ

| Fixture | Chế độ | Cặp | winner B | winner J | tool request J | selected | scored | deferred/uncertain | client failure |
|---|---|---|---|---|---|---|---|---|---|
| diagnostic-selection | select | 3 | 3/3 | 3/3 | 0 | 0 | 0 | 0 | 0 |
| patch-shortlist | score | 3 | 3/3 | 3/3 | 1 | 0 | 1 | 0 | 0 |
- diagnostic-selection: not exercised — tool có mặt nhưng không phiên nào gọi.
- patch-shortlist: n/a phiên điều trị có câu trả lời cuối trùng bước được chọn (select); 1 phiên trùng tập điểm cao nhất (score). Đây là **hiệp biến**, không phải chứng minh nhân quả: agent có thể tự đi đến cùng lựa chọn.

## 3. Thời gian

| Fixture | Cặp | agentMs B | agentMs J | median tỉ lệ J/B | min–max | cặp nhanh hơn |
|---|---|---|---|---|---|---|
| diagnostic-selection | 3 | 23873.6, 21800.6, 24536.6 | 31511.4, 22351.4, 23528 | 1.0253 | 0.9589–1.3199 | 1/3 |
| patch-shortlist | 3 | 21129.6, 21704.4, 22853.3 | 22601.6, 43929.8, 24254 | 1.0697 | 1.0613–2.024 | 0/3 |

- `agentMs` là thời gian phiên model, đã bao gồm mọi round-trip của arm điều trị; không có arm đối chứng 'buộc gọi tool rỗng' nên chưa tách được chi phí của chỉ thị so với chi phí của phán đoán.

## 4. Chi phí

| Fixture | Cặp | tổng cost B (USD) | tổng cost J (USD) | median tỉ lệ cost | cặp có đủ số liệu |
|---|---|---|---|---|---|
| diagnostic-selection | 3 | 0.029796, 0.019998, 0.029974 | 0.023553, 0.032739, 0.033437 | 1.1155 | 3/3 |
| patch-shortlist | 3 | 0.031428, 0.031758, 0.024197 | 0.030261, 0.033424, 0.021013 | 0.9629 | 3/3 |
- diagnostic-selection: main cost B 0.029796, 0.019998, 0.029974, điều trị 0.023553, 0.032739, 0.033437 USD; JEV 0 request, latency none ms, cost none USD.
- patch-shortlist: main cost B 0.031428, 0.031758, 0.024197, điều trị 0.030261, 0.033361, 0.021013 USD; JEV 1 request, latency 635.876 ms, cost 0.000063462 USD.
- Cùng mẫu số ở mọi tỉ lệ chi phí: **tổng cost của cả phiên** (model chính + mọi request JEV). Null giữ nguyên null — thiếu một thành phần thì tổng là unknown, không đổi thành 0.
- Trạng thái cost toàn batch: `reported` (subtotal đã biết 0.341578 USD, chưa đầy đủ).

## 5. Kết luận và giới hạn

- Collection: đủ 12/12 phiên, không abort.
- Chức năng: đạt (smoke + đăng ký + cách ly).
- Lợi ích đo được: không có / không đo được — xem bảng 3 và 4 theo từng trục riêng.
- n=3 cặp/fixture: mô tả, không phải kiểm định. Không suy ra calibration, không so chéo với batch cũ (runtime khác), và không dùng fixture select làm bằng chứng JEV giải được chẩn đoán nhiều bước.
- Private grader chạy ngoài workspace và hash của nó được đối chiếu trước/sau từng phiên; oracle không nằm trong prompt, tool input hay bất kỳ file nào agent đọc được.
