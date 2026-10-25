# Seguridad

## Cómo avisar de una vulnerabilidad

No abras un issue público. Usá el reporte privado de GitHub: pestaña **Security** → **Report a vulnerability**. El aviso sólo lo ve el mantenedor.

Incluí:

- la versión de Nemein y de Windows;
- los pasos para reproducirlo, con datos ficticios;
- qué puede hacer quien lo aprovecha.

No adjuntes presupuestos reales, extractos bancarios, tokens ni archivos `connection.env`.

## Qué cubre

- El motor de permisos y la bandeja de propuestas: una conexión que logra una acción sin permiso, o una propuesta que se aplica dos veces.
- Las credenciales de las conexiones MCP y CLI.
- El servidor local: controles de origen y CSRF, y que nunca escuche en la red.
- El instalador y la configuración MCP que se descarga.

Fuera de alcance: un programa que ya corre con el mismo usuario de Windows puede leer los archivos de ese usuario. Los permisos de Nemein no lo aíslan (ver [PRIVACIDAD.md](PRIVACIDAD.md)).

## Versiones

Nemein es experimental. Se corrige la versión más reciente publicada en [Releases](https://github.com/Danor07/nemein/releases).
