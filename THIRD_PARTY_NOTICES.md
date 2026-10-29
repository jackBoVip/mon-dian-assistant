# 第三方组件与资产声明

本项目随安装包分发下列第三方资产/依赖。除下表列出的部分外，其余代码均为本仓库自有实现。

## 随包分发的模型文件

答题助手的文字识别完全在本机完成，安装包内自带以下两个 ONNX 模型（合计约 21MB）：

| 资产 | 来源 | 版本 | 许可 |
|---|---|---|---|
| `ocr/ppocrv5/det/inference.onnx` + `inference.yml` | [PaddlePaddle/PP-OCRv5_mobile_det_onnx](https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx) | 修订 `e6f4fa85f00e168c862bc462aebca69eef9b3d3d` | Apache-2.0 |
| `ocr/ppocrv5/rec/inference.onnx` + `inference.yml` | [PaddlePaddle/PP-OCRv5_mobile_rec_onnx](https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_rec_onnx) | 修订 `ed152b8b495f84de93cda5709d768548a9127622` | Apache-2.0 |

- 版权归 PaddlePaddle Authors 所有。
- 本项目**未修改**上述文件：`scripts/prepare-ocr-models.mjs` 按钉死的修订下载，
  并用脚本内记录的 SHA-256 逐字节校验；校验不过就失败，不落盘。
- 模型目录不入库（`.gitignore`），构建前由上述脚本获取，随 `bundle.resources` 打进安装包。

## 直接依赖（Rust crate）

| crate | 用途 | 许可 |
|---|---|---|
| [`pure-onnx-ocr`](https://github.com/siska-tech/pure-onnx-ocr) 0.3.2 | 纯 Rust ONNX 推理（tract 后端）驱动上面的模型 | Apache-2.0 |
| [`xcap`](https://github.com/nashaofu/xcap) 0.9.8 | 跨平台屏幕捕获，用于取词 | Apache-2.0 |
| [`calamine`](https://github.com/tafia/calamine) 0.30.1 | 读 Excel 工作簿：`.xlsx` / `.xlsm` 与 BIFF 二进制 `.xls` 共用一条入口（题库导入） | MIT |
| [`undoc`](https://github.com/iyulab/undoc) 0.27.1 | 读 Word 97-2003 二进制 `.doc`（题库导入）；只启用 `doc` 与 `codepages` 两个 feature | MIT |

其余传递依赖的许可由 `Cargo.lock` 锁定版本决定，均可在 crates.io 对应页面查到。

Apache License 2.0 全文见 <https://www.apache.org/licenses/LICENSE-2.0>。
MIT License 全文见 <https://opensource.org/license/mit>。
