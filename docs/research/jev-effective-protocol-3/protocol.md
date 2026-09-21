# Protocol v3 — chốt lại ngưỡng của mode `select` bằng precision/recall

Trạng thái: **đóng băng trước request trả phí đầu tiên**. Sửa bất kỳ fixture, grid, luật chọn, tập huấn luyện/hold-out hay ngưỡng hiện tại ⇒ protocol mới, số liệu cũ không gộp.

## 1. Vì sao

v2 Stage 1 (`docs/research/jev-effective-protocol-2/runs/run-TJnels/`) cho thấy thất bại **duy nhất** của mode `select` là **từ chối**: 18/30 call trả `uncertain` dưới cổng 0.90, và **12/12 call đã ra quyết định thì đúng**. Nút chặn là ngưỡng, không phải model. Nhưng v2 **không ghi** `probability`/`probabilities` nên không trả lời được "hạ xuống mức nào". v3 sửa đúng chỗ đó và đóng băng luật chọn ngưỡng **trước** khi chạy — nếu không thì đây lại là tinh chỉnh hậu nghiệm.

## 2. Đo gì

- **Cùng 30 ngã rẽ của v2**, dùng nguyên `docs/research/jev-effective-protocol-2/cases.json` (hash vào `freeze.json`). Không sửa fixture nào: sửa fixture là protocol khác.
- **120 call trực tiếp** qua resolver OMP, không agent, không phiên model chính:

| Nhóm | Số call | Mục đích |
|---|---|---|
| 30 fork × 3 repeat, mode `select` | 90 | dữ liệu cho sweep ngưỡng (train 60 + hold-out 30) |
| 30 fork × 1, mode `score` | 30 | giữ con số `score` so sánh được với v2 |

- Mỗi call ghi thêm: `fork`, `kind` (read/edit/check), `repeat`, `oracle`, `status`, `reason`, `argmax` (candidate sản phẩm chọn), `argmaxProbability`, `probability` (giá trị sản phẩm trả cho lựa chọn), `probabilities` (phân bố đầy đủ), `latencyMs`, `costUsd`, `requestCount`, `requestBytes`, `questionCount`.
- `main`/`uncertain` **vẫn ghi** `probability`/`probabilities` — sản phẩm trả chúng; đây chính là phần v2 đánh rơi.
- `authoringErrors` tách khỏi `clientFailures` như v2.

## 3. Nhãn đúng/sai

Mỗi call `select`: `correct = (argmax === oracle)`. Oracle lấy nguyên từ `cases.json` (đã đóng băng ở v2, mỗi `contract` nằm nguyên văn trong `state`).

## 4. Luật chọn ngưỡng (đóng băng trước khi chạy)

Grid: `τ ∈ {0.50, 0.51, …, 0.99}`, xét **theo từng `kind`** vì sản phẩm có ngưỡng theo kind (`read` 0.90; `edit`/`check` 0.95).

Trên **tập huấn luyện** = repeat 1 và 2 (60 call, 20 mỗi kind):

- `committed(τ)` = số call có `probability ≥ τ`
- `precision(τ)` = `#correct` trong `committed` / `committed`
- `recall(τ)` = `#correct` trong `committed` / `#correct` trong toàn tập huấn luyện
- τ **hợp lệ** khi `committed(τ) ≥ 5` **và** `precision(τ) ≥ 0.95`

**Chọn**: τ nhỏ nhất hợp lệ (recall cao nhất); nếu hoà thì lấy τ lớn hơn. Nếu **không** τ nào hợp lệ → **giữ nguyên ngưỡng hiện tại**, kết luận "không đủ bằng chứng để hạ".

**Kiểm chứng trên hold-out** = repeat 3 (30 call, 10 mỗi kind). Ngưỡng chọn từ train chỉ được **chấp nhận** khi trên hold-out:

- `precision ≥ 0.90`, **và**
- `recall > recall(ngưỡng hiện tại)`

Không đạt một trong hai → **không đổi gì**, kết luận "hold-out từ chối".

Không có bước nào chạy lại sau khi xem kết quả. Nếu buộc phải chạy lại vì lý do endpoint (`clientFailures > 0`), giữ **cả hai** `results.json` và ledger ghi rõ lần sau thay lần trước vì lý do đó.

## 5. Áp dụng

- Chỉ khi §4 **chấp nhận**: đổi `PROBABILITY_THRESHOLDS` trong `src/decision-maker.ts` thành các τ đã kiểm chứng; cập nhật test đang pin ngưỡng; cập nhật README (Bounds + Measurement status). Không đổi gì khác — không đổi schema, không chuyển sang gate theo `confidence` (câu hỏi đó để protocol sau), không đổi `CALL_LIMIT`.
- Nếu §4 **từ chối**: không sửa dòng code nào; ghi lại rằng ngưỡng hiện tại đứng vững trên dữ liệu này và recall bị giới hạn bởi model, không bởi cổng.

## 6. Ngân sách, dừng, artifact

- **120 request**, ~0,0045 USD, dưới 2 phút; **0 phiên model chính**; 0 request của arm.
- Dừng khi: `authoringErrors > 0` (fixture lệch `prepare()`), `clientFailures > 3`, hoặc tổng call ≠ 120. Một `invalid_response` lẻ không dừng.
- Artifact: `docs/research/jev-effective-protocol-3/runs/run-*/` — `freeze.json`, `results.json`, `report.md`, `calls.frames.jsonl`. Artifact commit vào repo cùng `hashes.sha256`, không credential.

## 7. Freeze

`freeze.json` hash: `cases.json` (v2), runner, danh sách 120 call (fork × repeat × mode), grid τ, luật §4, các ngưỡng hiện tại (`read 0.90`, `edit 0.95`, `check 0.95`), và `metricRules`. Hash nào đổi giữa batch ⇒ batch vô hiệu.

## 9. Sửa đổi v3.1 — siết luật trước mọi phán quyết hợp lệ

Ghi rõ: **hai lần chạy v3 (run-lRkkWj, run-wgNHFd) đều vô hiệu** (`clientFailures` 50 và 75 > trần 3), nên chưa có phán quyết nào được áp dụng và việc siết dưới đây không phải tinh chỉnh hậu nghiệm — chưa có kết quả nào để nhìn. Lần chạy đầu (dù vô hiệu) đã cho thấy nhánh degenerate **có thật**: nó chọn τ = 0.50 cho cả ba kind.

Bốn siết, tất cả đã được self-check chứng minh trên đường cong tổng hợp:

1. **Sàn lưới**: τ chọn được phải **> 0.50**. Nếu đường cong chỉ hợp lệ ở đúng sàn thì từ chối với lý do "dữ liệu muốn một ngưỡng dưới sàn lưới — protocol này không quyết được", không ship 0.50 như một kết quả đo.
2. **Hold-out phải đủ dày**: ngoài `precision ≥ 0.90`, cần `committed ≥ 5` **và** `correct ≥ 5` trên hold-out. Một call 1/1 không phải bằng chứng.
3. **Mốc so sánh phải tồn tại**: nếu ngưỡng hiện tại không commit được call nào trên hold-out thì `recall(current) = 0` và mọi recall dương đều "tốt hơn" — so sánh đó là **vô nghĩa**, trả về không quyết được chứ không tính là thắng.
4. **Coverage**: chỉ in phán quyết "chấp nhận" khi đúng số điểm của kế hoạch (train 20/kind, hold-out 10/kind); thiếu thì "coverage không đạt kế hoạch — không có phán quyết".

Thêm hai thứ vào đường chạy:

5. **Health pre-flight trong chính batch**: 10 call đầu là cửa sổ sức khoẻ. Một call có HTTP ≥ 500 hoặc **không phản hồi** (timeout) trong 10 call đó ⇒ **dừng ngay**, không gửi 110 call còn lại, batch vô hiệu. Ngoài ra **fail-fast**: 5 lỗi liên tiếp ở bất kỳ đâu cũng dừng batch, để một cửa sổ outage không đốt phần đuôi và để lại tập sống sót lệch về một vùng của kế hoạch.
6. **Thứ tự plan đổi sang repeat-major** (30 fork ở repeat 1, rồi repeat 2, rồi repeat 3, rồi 30 call score): một cửa sổ outage làm mỏng mọi kind theo cùng tỉ lệ, thay vì xoá trắng hold-out của một kind như lần trước (outage ở đầu và cuối kế hoạch fork-major đã xoá F1–F5 và F25–F30).

Bằng chứng ghi thêm mỗi call: `httpStatus`, `retryAfter`, `rateRemaining` — vì sản phẩm gộp mọi non-2xx vào một reason `http_error`, nên không có chúng thì một batch vô hiệu không phân biệt được với một bức tường quota.

## 8. Lệnh

```sh
bun docs/research/jev-effective-protocol-2/runner.ts --v3
```
