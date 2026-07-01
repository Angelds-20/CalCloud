# CalCloud - Monitor de Autoscaling Autónomo

**CalCloud** es una aplicación web interactiva de simulación a nivel de producción desarrollada para la asignatura de **Cálculo Diferencial** en **INACAP Talca**. La plataforma demuestra de forma visual y cuantitativa los beneficios de optimizar la asignación de infraestructura en la nube utilizando derivadas y aproximaciones lineales (diferenciales) en comparación con las políticas reactivas tradicionales basadas en umbrales estáticos, incorporando fricciones del mundo real.

---

## 👥 Integrantes y Docente
*   **Integrantes:** Yossadec Cáceres • Patricio Moya • Cesar Contreras • Nicolas Saldia
*   **Docente:** Marcelo Andrés Sepúlveda Albornoz
*   **Institución:** INACAP Talca

---

## 📐 Fundamento Matemático y Fricción de Producción

El simulador implementa las siguientes soluciones analíticas detalladas en la ficha técnica del proyecto y adaptadas para entornos de producción reales:

### 1. Filtro de Ruido (Suavizado EMA)
Para evitar que el cálculo de la derivada reaccione a micro-picos engañosos causados por el tráfico estocástico y ruidoso, la señal de entrada se procesa mediante una **Media Móvil Exponencial (EMA)**:

$$R_{\text{smooth}}(t) = \alpha_{\text{ema}} \cdot R(t) + (1 - \alpha_{\text{ema}}) \cdot R_{\text{smooth}}(t-1)$$

La razón de cambio instantánea se calcula directamente sobre la curva suavizada y estable.

### 2. Tiempo de Arranque ($T_a$) e Horizonte de Predicción
Las máquinas físicas en la nube tardan un tiempo de aprovisionamiento ($T_a$) en encenderse. CalCloud simula este retardo de arranque usando una cola de espera. Para anticiparse a este delay, la ventana de proyección infinitesimal ($dt$) se expande hasta el horizonte del tiempo de arranque ($T_a$):

$$dR = \frac{dR_{\text{smooth}}}{dt} \cdot T_a$$

$$R_{\text{pred}}(t + T_a) = R_{\text{smooth}}(t) + dR$$

### 3. Modelo Híbrido (Predictivo + Reactivo Fail-Safe)
El motor de autoscaling utiliza el cálculo diferencial para realizar un aprovisionamiento predictivo suave y eficiente. Sin embargo, para responder ante eventos extremos e impredecibles (como un ataque DDoS inyectado manualmente), el sistema cuenta con un **fail-safe reactivo**: si la carga real de CPU activa supera el **85%** o la latencia excede los **300ms**, se dispara inmediatamente el encendido de un servidor de emergencia para proteger la plataforma.

### 4. Tarifas Escalonadas (Modelo Facturación AWS)
El costo total operativo ($C$) se evalúa sobre escalones de precios comerciales reales:
*   **Costo de Servidores:** Estructura escalonada. Las primeras 3 instancias (base reservada) tienen costo estándar, y las instancias de la 4 a la 10 (on-demand) se facturan con un recargo del **50%** extra.
*   **Multas por SLA:** Penalizaciones cobradas en rangos de latencia reales ($W$):
    *   $W \le 100$ms: $\$0$/h.
    *   $100$ms $< W \le 250$ms: $\$50$/h.
    *   $250$ms $< W \le 500$ms: $\$200$/h.
    *   $500$ms $< W \le 1.0$s: $\$1000$/h.
    *   $W > 1.0$s: $\$5000$/h (caída catastrófica).

---

## 🛠️ Estructura del Panel de Control (Tab Routing)

El dashboard cuenta con un sistema de navegación por pestañas indexado por la URL (**Hash Routing**):

1.  **`/` o `#dashboard` (Simulación):** Muestra el gráfico principal dominante de tráfico en tiempo real, el rack físico de servidores con luces LED animadas (verde activa, amarillo parpadeante inicializando, gris inactiva) y los controles de simulación rápida con deslizador de **Inyección de Anomalías**.
2.  **`#analytics` (Análisis):** Presenta la curva matemática de costos $C(S)$ y la tabla comparativa de rendimiento técnico-financiero acumulado.
3.  **`#math` (Matemáticas):** Detalle analítico de las fórmulas LaTeX con variables y derivadas calculadas en vivo segundo a segundo.
4.  **`#config` (Configuración):** Panel exclusivo para calibrar parámetros de producción como el tiempo de arranque $T_a$, el factor $\alpha_{\text{ema}}$, capacidad de servidor $\mu$, costo base e indemnizaciones SLA.
5.  **`#about` (Acerca de):** Concentra la información académica formal, el contexto universitario del proyecto e integrantes.

---

## 🚀 Instrucciones de Ejecución

1. Navega hasta la carpeta del proyecto: `/home/angel/Descargas/calculo`.
2. Ejecuta el script del servidor:
   ```bash
   ./iniciar_servidor.sh
   ```
3. Abre tu navegador web en: **`http://localhost:8000`**

---

## 🤖 Integración ChatOps (Asistente de IA Opcional)

CalCloud cuenta con un copiloto de operaciones en tiempo real impulsado por la API de **DeepSeek**. Para utilizarlo de forma segura y privada:

1. Ingresa al panel de control en tu navegador.
2. Ve a la pestaña **Configuración** (`#config`).
3. En la sección **Asistente de IA (ChatOps)**, introduce tu clave API de DeepSeek (`sk-...`).
4. Haz clic en **Guardar**.

> [!NOTE]
> Por motivos de seguridad y para cumplir con las mejores prácticas de desarrollo, **tu clave de API no se almacena en el servidor ni se sube a GitHub**. Se guarda exclusivamente de forma local en el `localStorage` de tu propio navegador web, y las llamadas a la API de DeepSeek se realizan de manera directa y cifrada desde tu cliente.

