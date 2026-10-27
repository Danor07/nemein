# Respaldos con la ventana cerrada

`nemein.cmd backup` abre el presupuesto, comprueba el permiso `backup`, usa la API de backup de SQLite y cierra la base. No necesita la ventana ni un servicio de fondo. Requiere una conexión propia con **Crear respaldo local** en permitir; preguntar no admite esta operación asíncrona. El token se mantiene en el archivo privado de credenciales.

Sin `BUDGET_BACKUP_DIR`, se conserva la primera copia de cada día en `backups/` dentro del presupuesto y las últimas 30 copias diarias. Con esa variable, el destino debe ser una carpeta absoluta **ya existente**, por ejemplo un USB o una carpeta sincronizada que el usuario eligió. Una unidad ausente produce error y salida no cero; no se crea un reemplazo en otro disco.

Las copias externas usan una subcarpeta por identidad del presupuesto y un archivo nuevo por ejecución. Primero se completa SQLite en un temporal y luego se publica el `.db`. No se sobrescriben ni se borran copias externas automáticamente. El propietario administra su espacio. La carpeta puede estar en el mismo disco: Nemein no puede certificar independencia física ni que un proveedor haya terminado de sincronizar. Para protección ante fallo del disco, elegir otro dispositivo o comprobar la sincronización externa.

## Programador de tareas de Windows

Crear una conexión en **Permisos y propuestas**, descargar su configuración y dar sólo el permiso `backup`. Usar rutas instaladas, no `target` ni el checkout. Crear manualmente una tarea diaria para el mismo usuario, marcar «Ejecutar la tarea lo antes posible si no se inició cuando estaba programada» y evitar instancias simultáneas. El equipo debe estar encendido y el destino disponible.

Programa: `powershell.exe`. Argumentos (una línea; reemplazar las rutas de ejemplo por las propias):

```powershell
-NoProfile -NonInteractive -Command "$env:BUDGET_DATA_DIR='C:\Datos\Presupuesto'; $env:BUDGET_AGENT_TOKEN_FILE='C:\Datos\credencial.txt'; $env:BUDGET_AGENT_VERSION='1'; $env:BUDGET_BACKUP_DIR='E:\Respaldos'; & 'C:\Aplicaciones\Nemein\nemein.cmd' backup; exit $LASTEXITCODE"
```

La línea contiene la ubicación del archivo privado, no su token. Ejecutar una vez a mano y comprobar el JSON con `ok: true`, el archivo devuelto y el resultado 0 de la tarea. Un fallo no confirma un respaldo. No se instala ninguna tarea ni se elige una unidad automáticamente.

## Comprobar y recuperar

La copia SQLite incluye el presupuesto completo, las revisiones y la configuración de acceso almacenada en la base. No incluye los archivos externos de credenciales. Tratarla como privada; una exportación JSON/CSV financiera tiene un alcance diferente.

Para ensayar una recuperación, usar una carpeta temporal vacía y una copia del `.db` renombrada a `budget.db`, con `BUDGET_DATA_DIR` apuntando a esa carpeta. Verificar integridad, saldos y registros allí. Para recuperar el presupuesto habitual, cerrar ventana, tareas y clientes, conservar primero la carpeta anterior completa y recuperar en una carpeta nueva; no reemplazar una base dejando sus archivos WAL/SHM anteriores. Nunca ensayar sobre los datos personales.
