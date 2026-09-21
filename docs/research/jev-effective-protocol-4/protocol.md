# Protocol v4 — chẩn đoán `invalid_response` trước, rồi mới tới ngưỡng

Trạng thái: **đóng băng trước request trả phí đầu tiên**. Sửa fixture, grid, tập train/hold-out, luật hay instrumentation ⇒ protocol mới.

Thứ tự công việc do người dùng chốt: **(1) giữ body khi `invalid_response` và chạy lại để phân biệt "endpoint trả sai dạng" với "validator của ta quá chặt" → (2) lưới mịn → (3) hold-out dày.** v4 gộp cả ba vào một lần chạy, nhưng **phán quyết ngưỡng chỉ được đọc sau khi (1) đã trả lời xong**.

## 1. Vì sao

Ba lần chạy v3 đều vô hiệu: hai lần vì endpoint (50 và 75 client failure, toàn 503/529/timeout), lần thứ ba thì endpoint **lành** (cả 120 call HTTP 200) nhưng vẫn vô hiệu vì **6 `invalid_response`**, 5/6 ở mode `score`. Cộng dồn ~10 `invalid_response` trên ~380 call, tập trung ở `score`. Không phân biệt được hai khả năng — endpoint trả sai dạng, hay validator của client quá chặt — vì sản phẩm huỷ body khi response không hợp lệ và chỉ trả về một reason.

## 2. Instrumentation (1)

- Wrapper `fetch` của harness gọi `response.clone()` **trước** khi sản phẩm đọc response gốc; sản phẩm vẫn nhận bản gốc và vẫn huỷ body như thường.
- **Chỉ khi** `reason === "invalid_response"` mới đọc bản clone và giữ **tối đa 2000 ký tự** vào `responseBody` của call đó. Mọi call khác không giữ gì.
- Body giữ lại đi qua đúng danh sách redaction như mọi byte khác của artifact trước khi ghi `results.json`.
- Mỗi call vẫn ghi `httpStatus`, `retryAfter`, `rateRemaining` như v3.

## 3. Spend bound (đã đổi so với v3)

- Cửa sổ sức khoẻ 10 call đầu: **bất kỳ non-2xx nào** cũng dừng batch. Nhãn nói đúng lớp: `health` khi status là null hoặc ≥ 500 (provider hỏng), `rejected` khi 4xx (yêu cầu của ta bị từ chối). Trước đây 4xx không chặn gì, nên một batch toàn 400 vẫn chạy hết 120 rồi mới bị vô hiệu.
- Fail-fast: 5 lỗi liên tiếp ở bất kỳ đâu cũng dừng.

## 4. Kế hoạch 180 call (2 và 3)

- **30 fork × 5 repeat mode `select`** = 150 call, xếp **repeat-major** (r1 cả 30 fork, r2, …, r5) + **30 call `score`**.
- Train = repeat 1–3 ⇒ **30 điểm/kind**; hold-out = repeat 4–5 ⇒ **20 điểm/kind**. (v3 là 20/10.)
- **Grid 0.40 → 0.99, bước 0.01** (60 giá trị). Sàn hạ từ 0.50 xuống 0.40 vì hai lần gần nhất sweep đòi một giá trị ở hoặc dưới sàn cũ.
- Ngân sách: ~0,007 USD, dưới 4 phút, **0 phiên model chính**.

## 5. Luật ngưỡng (không đổi ngoài grid và volume)

Với từng `kind`, trên train (r1–r3):
- `committed(τ)` = call có `probability ≥ τ`; `precision`, `recall` như cũ.
- τ hợp lệ khi `committed ≥ 5` **và** `precision ≥ 0.95` **và** `τ > 0.40` (sàn lưới).
- Chọn **τ nhỏ nhất hợp lệ**; nếu không có ⇒ "dữ liệu muốn một ngưỡng dưới sàn lưới — protocol này không quyết được" hoặc "không τ nào hợp lệ".

Trên hold-out (r4–r5), chấp nhận chỉ khi **cả bốn**:
1. `committed ≥ 8` **và** `correct ≥ 8` (volume, không nhận 1/1 hay 5/5);
2. `precision ≥ 0.90`;
3. `recall > recall(ngưỡng hiện tại)` — **và** ngưỡng hiện tại phải commit được ≥ 1 call trên hold-out, nếu không thì so sánh từ mốc 0 là **vô nghĩa** và bị từ chối;
4. coverage đúng kế hoạch: **30 điểm train và 20 điểm hold-out mỗi kind**; thiếu ⇒ "coverage không đạt kế hoạch — không có phán quyết".

## 6. Đọc kết quả theo thứ tự (đóng băng)

1. **Trước hết đọc `responseBody` của mọi call `invalid_response`.** Phân loại từng cái: (a) endpoint trả dạng khác hợp đồng (ví dụ thiếu `answers`, `choice` không phải cực đại, tổng xác suất lệch, `legend` khác rubric), hay (b) response hợp lệ nhưng validator client từ chối nhầm. Kết luận này **đứng độc lập**: nó đúng kể cả khi batch vô hiệu.
2. Nếu `authoringErrors > 0` ⇒ case file sai, sửa rồi chạy lại, không đọc tiếp.
3. Nếu `clientFailures > 3` ⇒ **batch vô hiệu: không áp dụng ngưỡng nào**, chỉ giữ phần chẩn đoán ở (1).
4. Nếu batch hợp lệ ⇒ đọc phán quyết sweep ở §5. Chỉ khi có `accepted` mới sửa `PROBABILITY_THRESHOLDS`, cập nhật test pin ngưỡng và README; nếu không `accepted` thì **không sửa dòng code nào**.

Không chạy lại vì kết quả không thuận; chỉ chạy lại vì `clientFailures > 0` (sức khoẻ endpoint), giữ cả hai `results.json`, ledger ghi rõ lần sau thay lần trước vì lý do đó.

## 7. Artifact và freeze

- `docs/research/jev-effective-protocol-4/runs/run-*/`: `freeze.json`, `results.json`, `report.md`, `calls.frames.jsonl`; commit kèm `hashes.sha256`, không credential.
- `freeze.json` hash: `cases.json` (của v2), runner, `protocol.md` này, grid, `SweepParams`, luật §5, ngưỡng hiện tại, `metricRules`, và cờ `capturesRejectedBodies`.

## 8. Lệnh

```sh
bun docs/research/jev-effective-protocol-2/runner.ts --v4
```
