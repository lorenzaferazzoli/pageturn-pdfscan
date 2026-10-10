#!/bin/sh
# Scarica i modelli PaddleOCR in vendor/paddle (servono solo se si aggiornano).
set -e
B=https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main
R=https://raw.githubusercontent.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main
mkdir -p vendor/paddle
curl -fL -o vendor/paddle/det.onnx "$B/detection/PP-OCRv5_mobile_det_infer.onnx"
curl -fL -o vendor/paddle/rec-latin.onnx "$B/recognition/multi/latin/v5/latin_PP-OCRv5_mobile_rec_infer.onnx"
curl -fL -o vendor/paddle/dict-latin.txt "$R/recognition/multi/latin/v5/ppocrv5_latin_dict.txt"
# UVDoc: si tiene solo la parte che stima la griglia (serve pip install onnx)
curl -fL -o /tmp/UVDoc.onnx "$B/correction/UVDoc.onnx"
python3 scripts/uvdoc-grid.py /tmp/UVDoc.onnx vendor/paddle/uvdoc-grid.onnx
