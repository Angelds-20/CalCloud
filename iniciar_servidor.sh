#!/bin/bash
echo "=========================================================="
echo "          INICIANDO SERVIDOR LOCAL PARA CALCLOUD           "
echo "=========================================================="
echo "Dirección del simulador: http://localhost:8000"
echo "Presiona Ctrl+C para detener el servidor."
echo "=========================================================="
python3 -m http.server 8000
