# Guía de wetaca-cli

Verificada contra una cuenta real (nov 2026). Lecturas = sin riesgo. Acciones = piden confirmación.
Los ids y direcciones de los ejemplos son ficticios.

## 1. Consultar (lectura, sin riesgo)

```bash
wetaca me                          # tu cuenta: suscripción, cartera
wetaca suggestion show             # LA ESTRELLA: menú de la semana próxima por perfil,
                                   # ventana de entrega, dirección y precio total
wetaca suggestion show --format pretty
wetaca deliveries next             # sugerencia + pedidos pendientes + pagos pendientes
wetaca orders list --limit 10      # histórico de pedidos (id, referencia, fecha, importe, factura)
wetaca orders show 1234567         # detalle de un pedido: platos, dirección, franja
wetaca orders list --limit 3 --format jsonl   # una línea JSON por pedido (ideal jq/scripts)
wetaca addresses list
wetaca vouchers list
wetaca wallet
```

Con `jq`:
```bash
wetaca suggestion show | jq '.deliveryWindow'                       # cuándo te toca
wetaca suggestion show | jq '.profiles[0].products[].name'          # qué platos tocan
wetaca orders list | jq 'map(select(.state=="PAYMENT_CONFIRMED"))'  # solo pagados
```

## 2. Acciones (efectos reales; piden confirmación o --yes)

### Saltar la semana próxima
```bash
wetaca suggestion pause            # pide y/N en el terminal
wetaca suggestion pause --yes      # sin prompt (scripts/agentes)
wetaca suggestion resume           # deshacer
```
El `validUntil` de `suggestion show` es el deadline: esa fecha y hora deja de poder editarse.

### Cambiar tuppers del menú de la semana
```bash
# 1. mira los ids: productId (los platos) y profileSuggestionId (tu menú de la semana)
wetaca suggestion show | jq '.profiles[0] | {profileSuggestionId, products: [.products[] | {id, name, quantity}]}'

# 2. simula el cambio (--set "productId:cantidad,productId:cantidad"; cantidad 0 = quitar)
wetaca suggestion edit --profile-suggestion <PROFILE_SUGGESTION_ID> --set "124:2" --dry-run

# 3. ejecuta
wetaca suggestion edit --profile-suggestion <PROFILE_SUGGESTION_ID> --set "124:2" --yes
```

### Pausar las vacaciones
```bash
wetaca subscription pause --weeks 2 --yes   # pausa 2 semanas
wetaca subscription resume                  # reactiva
wetaca subscription show                    # estado actual
```

### Ver el menú de la semana y elegir platos
```bash
wetaca menu list                                  # 43 platos con id, categoría y precio
wetaca menu list | jq '.dishes[] | select(.category.slug=="entrantes") | {id, name}'
wetaca dish show lasana-de-pavo-y-pesto           # ingredientes, alérgenos, descripción
```

### Cambiar la franja de entrega
```bash
wetaca deliveries options                         # franjas disponibles (la actual sale con isCurrent)
wetaca deliveries set-option 117 --dry-run        # simula
wetaca deliveries set-option 117 --yes            # aplica a suscripción + semana próxima
```

### Perfiles
```bash
wetaca profiles list
wetaca profiles pause <id|nombre> --dry-run       # pausa solo ese perfil
```

### Cambiar la dirección de entrega
```bash
# simulación del plan exacto (nada se toca)
wetaca addresses save --street "Calle Ejemplo" --number 1 --floor 2A --zipcode 18006 --city Granada --dry-run

# ejecuta (pide confirmación; --yes para scripts): crea la dirección y la asigna a la
# suscripción y a la semana próxima, conservando la franja de entrega actual
wetaca addresses save --street "Calle Ejemplo" --number 1 --floor 2A --zipcode 18006 --city Granada --yes
```
Nombre, apellido, teléfono y notas se heredan de tu dirección actual salvo que pases
--firstname/--lastname/--phone/--notes. Verifica después con `wetaca addresses list`.

### Cancelar un pedido confirmado
```bash
wetaca orders cancel 1234567 --dry-run      # ver qué haría
wetaca orders cancel 1234567 --yes          # cancelar (devuelve el importe)
```

## 3. Automatizar con agentes IA

Los agentes (Hermes, Claude, un cron...) deben empezar por:
```
wetaca skills get wetaca-usage
```
Esa guía embebida siempre coincide con la versión instalada y describe el contrato:
JSON en stdout, errores JSON con `--error-format json`, exit codes estables
(0 ok · 2 uso/confirmación · 3 auth · 4 red · 5 no encontrado · 6 API · 7 deriva),
`--no-input` + `--yes` para no interactivo, `--dry-run` para simular.

Regla de oro para agentes: leer mucho, escribir poco y con resumen antes del `--yes`.

Ideas de automatización (cron):
- Cada jueves: `suggestion show` → resumen por Telegram → tú respondes cambios → agente aplica con `--yes`.
- Cada miércoles: si `suggestion show | jq -r .validUntil` está cerca y `skip=false`, avisar para decidir pausa.
- Alerta de factura: `orders list` → si aparece un pedido nuevo respecto a la última vez, notificar.

## 4. Sesión

- Estado: `wetaca auth status` · Renovar: `wetaca auth login --cookies cookies.txt` (export con Cookie-Editor) o `--refresh-token <COOKIE>` (F12 → Application → Cookies → `refresh-token`; dura ~120 días y el CLI renueva el token solo). Alternativa: `wetaca auth login --token <TOKEN> --clipboard` (caduca ~1h).
- El token vive en `~/.config/wetaca-cli/credentials.json` (0600) y el resto de ajustes en `config.json`; `WETACA_TOKEN` lo sobreescribe (CI).
- Si la API lo rechaza (exit 3), repite la extracción con DevTools (docs/cli-spec.md §6).
