# AgarMon web v0.2

## Navegador y servidor

El navegador muestra una interfaz en HTML, CSS y JavaScript con diseños para escritorio y móvil. Los saldos provienen del servidor; no se guardan como autoridad en `localStorage`. Cada operación financiera deriva su usuario de la sesión del servidor, nunca de un `userId` recibido en el cuerpo HTTP.

Node.js sirve los archivos públicos y una API JSON. El núcleo monetario realiza las escrituras en `money.sqlite`; credenciales y sesiones viven en `auth.sqlite`.

## Sesiones

- Contraseñas con sal y derivación `scrypt`, nunca almacenadas en texto.
- Tokens de sesión aleatorios de 256 bits; la base de datos guarda su SHA-256.
- Cookies `HttpOnly`, `SameSite=Strict`, `Path=/`, duración de un día y `Secure` cuando `PUBLIC_ORIGIN` usa HTTPS.
- Registro o login emiten un token nuevo y revocan el anterior de ese navegador.
- Los cambios autenticados requieren un token CSRF y el origen exacto configurado.
- Se limita la concurrencia de derivaciones de contraseña y los intentos por IP. Estos límites son por proceso, no un servicio antifraude distribuido.
- Las respuestas de sesión/billetera no se cachean. CSP impide scripts externos y embebidos, y la app no permite ser enmarcada.

Las cuentas del sandbox asignan una identidad ficticia en el país de pruebas `ZZ`. Ese paso no constituye verificación de edad, residencia o identidad. El arranque en modo `live` se rechaza para impedir que una configuración accidental convierta cuentas de prueba en participantes reales.

## API

| Ruta | Acceso | Resultado |
|---|---|---|
| `GET /api/state` | Público; contenido privado según sesión | Usuario actual, su billetera/historial/retiros pendientes y resumen de salas |
| `POST /api/register` | Origen permitido | Cuenta de prueba y sesión |
| `POST /api/login` | Origen permitido | Sesión nueva |
| `POST /api/logout` | Sesión, CSRF y origen | Revoca sesión |
| `POST /api/demo/funds` | Sesión, CSRF y origen | Acredita únicamente fondos ficticios, con clave de repetición |
| `POST /api/rooms/:id/join` | Sesión, CSRF y origen | Reserva la entrada del usuario actual |
| `POST /api/rooms/:id/leave` | Sesión, CSRF y origen | Devuelve su entrada si la sala no empezó |
| `POST /api/demo/withdrawals` | Sesión, CSRF y origen | Reserva un retiro ficticio |
| `POST /api/demo/withdrawals/:id/resolve` | Propietario, CSRF y origen | Confirma un resultado de prueba o devuelve la reserva |

No existen rutas públicas para acreditar pagos reales, cambiar KYC, resolver retiros reales, eliminar jugadores, recoger doradas arbitrariamente ni iniciar la partida sin el motor de juego. Los endpoints `/api/demo/*` son un simulador explícito, no adaptadores de un proveedor.

Los IDs de petición de entradas, cargas y retiros permiten repetir una operación sin descontar/acreditar de nuevo. Una respuesta perdida puede reconciliarse consultando el estado; los retiros pendientes siguen visibles al recargar.

## Qué falta

- Arena y servidor autoritativo: movimiento, colisiones, masa, división de células y reloj compartido.
- Despliegue con dominio/TLS y configuración de copias de seguridad.
- Recuperación de contraseña y verificación de correo antes de un servicio público.
- Servicios independientes de identidad, edad y geolocalización, jurisdicciones habilitadas y proveedor comercial compatible.
- Sustituir las rutas de simulación por flujos de pagos verificados; nunca conectar los actuales controles de prueba a dinero real.
- Bandeja de pagos, conciliación, manejo de disputas/contracargos y operación de partidas interrumpidas.

Esta entrega permite revisar la interfaz y el flujo monetario en una app web local. No publica una plataforma de apuestas ni incluye un ejecutable Android.
