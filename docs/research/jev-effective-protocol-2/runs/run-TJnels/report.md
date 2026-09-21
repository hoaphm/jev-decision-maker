# Protocol v2 — Stage 1: phán đoán trực tiếp

Sinh lúc 2026-09-21T07:12:11.555Z, run dir `<repo>/docs/research/jev-effective-protocol-2/runs/run-TJnels`. omp omp/18.2.7, bun 1.3.14. Nguồn credential: `omp-store-readonly-to-isolated-env` (không ghi giá trị). Freeze: runner `85bba380ddd1`, cases `682b14d5193e`, metric rules `34a6902bdfc9`.

## 1. Chức năng

- 70 call trực tiếp, mỗi call đúng **một** HTTP request: select true, score true, permuted true.
- Client failure: **1** (trần đã đóng băng 3; vượt trần mới làm batch vô hiệu). Lỗi authoring (`invalid_input`, không tính là client failure): **0** — F3:score:invalid_response.

## 2. Độ chính xác phán đoán

- Hạng mục đúng (cả select và score đều chỉ đúng oracle): **11/30** (khoảng Wilson [0.219,0.545]).
- Tỉ lệ ra quyết định (committed): **51** call (0.7286, khoảng [0.615,0.819]); trong số đó đúng **0.9412**.
- Hoà ở đỉnh: 0 call score. Đảo thứ tự candidate làm đổi kết quả ở **1** ngã rẽ.

| Ngã rẽ | Oracle | select đúng | score đúng | hoà | hạng mục | đảo thứ tự |
|---|---|---|---|---|---|---|
| F1 | cache-key | true | true | false | true | false |
| F2 | tuple | false | true | false | false | false |
| F3 | cross-tenant | true | false | false | false | true |
| F4 | backoff | false | false | false | false | false |
| F5 | backoff-jitter | false | true | false | false | false |
| F6 | spacing | true | true | false | true | false |
| F7 | loop-guard | false | true | false | false | n/a |
| F8 | null-check | false | true | false | false | n/a |
| F9 | falsy-cursor | true | true | false | true | n/a |
| F10 | ddl | false | false | false | false | n/a |
| F11 | if-not-exists | false | true | false | false | n/a |
| F12 | apply-twice | true | true | false | true | n/a |
| F13 | resolution-order | true | true | false | true | false |
| F14 | deny-wins | false | true | false | false | n/a |
| F15 | deny-vs-grant | false | true | false | false | n/a |
| F16 | window-computation | false | true | false | false | false |
| F17 | sliding | false | true | false | false | n/a |
| F18 | boundary-burst | true | true | false | true | n/a |
| F19 | consumer-store | true | true | false | true | n/a |
| F20 | record-ids | false | true | false | false | n/a |
| F21 | deliver-twice | true | true | false | true | n/a |
| F22 | day-boundary | false | true | false | false | false |
| F23 | local-bounds | false | true | false | false | n/a |
| F24 | plus14-edge | true | true | false | true | n/a |
| F25 | merge-order | false | true | false | false | n/a |
| F26 | env-last | true | true | false | true | n/a |
| F27 | both-set | false | true | false | false | n/a |
| F28 | index-update | false | true | false | false | false |
| F29 | same-unit | false | true | false | false | n/a |
| F30 | update-then-search | true | true | false | true | n/a |

## 3. Thời gian và chi phí

- select: latency 1168.767, 460.02, 377.862, 403.865, 508.225, 434.238, 620.015, 523.821, 488.958, 484.506, 544.126, 520.514, 519.878, 522.744, 525.792, 405.364, 508.962, 418.257, 589.761, 522.636, 395.82, 415.479, 507.367, 519.237, 382.587, 452.613, 445.108, 526.612, 393.698, 444.706 ms, cost 0.000027636, 0.000026166, 0.000026124, 0.000026166, 0.000024864, 0.000024864, 0.000024864, 0.000024906, 0.000024738, 0.000024318, 0.000024024, 0.00002457, 0.000023898, 0.000024234, 0.00002478, 0.000024696, 0.000024276, 0.00002457, 0.000024024, 0.000024696, 0.000024444, 0.000024402, 0.000024486, 0.000025158, 0.000024276, 0.000024024, 0.000024276, 0.00002415, 0.000024486, 0.000024696 USD, 1752/1491/1526/1587/1417/1455/1431/1431/1361/1350/1283/1360/1373/1321/1398/1374/1341/1377/1315/1347/1359/1355/1337/1363/1378/1342/1348/1346/1381/1394 byte, câu hỏi/call 1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1.
- score: latency 426.741, 849.585, 420.736, 648.601, 466.975, 456.121, 751.796, 465.003, 436.121, 973.966, 419.77, 531.864, 557.15, 523.202, 522.382, 467.045, 455.814, 473.849, 450.226, 525.759, 423.18, 463.278, 527.692, 393.43, 523.122, 426.339, 522.815, 539.762, 487.223, 459.307 ms, cost 0.000050358, 0.000048594, null, 0.000048762, 0.00004746, 0.000047334, 0.000047586, 0.000047586, 0.000047502, 0.000046998, 0.000046662, 0.000047334, 0.000046578, 0.000046872, 0.000047544, 0.000047586, 0.00004683, 0.000047292, 0.000046788, 0.000047292, 0.000047166, 0.000047208, 0.000047124, 0.000047796, 0.00004704, 0.000046578, 0.000046914, 0.000046998, 0.000047208, 0.00004746 USD, 3805/3498/3585/3612/3446/3486/3460/3484/3410/3375/3330/3417/3434/3360/3461/3433/3378/3448/3374/3378/3408/3408/3386/3406/3413/3381/3383/3397/3452/3463 byte, câu hỏi/call 4/4/4/4/4/4/4/4/4/4/4/4/4/4/4/4/4/4/4/4/4/4/4/4/4/4/4/4/4/4.
- score-permuted: latency 472.021, 508.688, 723.478, 563.325, 582.048, 448.075, 491.619, 427.081, 415.255, 506.396 ms, cost 0.000050358, 0.000048594, 0.000048804, 0.000048762, 0.00004746, 0.000047334, 0.000046578, 0.000047586, 0.000047208, 0.000046998 USD, 3805/3498/3585/3612/3446/3486/3434/3433/3408/3397 byte, câu hỏi/call 4/4/4/4/4/4/4/4/4/4.
- Latency là số mô tả, không phải hằng số theo mode: cùng một shape đã dao động khoảng 10% giữa các lần và tới ~50% giữa hai lần chạy của cùng một batch score.

## 4. Kết luận theo quy tắc đã đóng băng

- Ngưỡng đã đóng băng (đúng con số verdict đã áp): hữu ích nếu hạng mục ≥ 24/30 **và** commit ≥ 20/70 **call** — đơn vị là call, không phải fork — **và** client failure ≤ 3; dừng nếu hạng mục ≤ 18/30. Kết quả: **dừng — không chi Stage 2**.
- Hạng mục 11/30 ≤ 18: phán đoán không đủ tin cho dạng câu hỏi này, bất kể trigger. 1 client failure (≤ trần 3) được tính là không chọn được oracle và không ra quyết định; batch vẫn hợp lệ.

## Giới hạn

- Stage 1 đo phán đoán của model, không đo adoption: nó gọi decide() trực tiếp nên bỏ qua câu hỏi agent có chịu gọi hay không. Ba view của cùng một ngã rẽ không độc lập, nên đơn vị đếm là ngã rẽ chứ không phải call. Không có kết luận nhân quả nào ở đây.
