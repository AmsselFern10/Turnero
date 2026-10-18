# Plan B — Continuidad Operativa
### Turnero de Matriculas 2026

---

## Si el sistema deja de responder durante el proceso

**Para el personal de ventanilla:**

1. No pares la atencion. Los vouchers fisicos siguen siendo validos.
2. Avisa a los demas operadores: *"El sistema no responde — modo manual"*.
3. Cada operador anota en papel: numero de turno, hora de llamado y resultado (atendido / no se presento).
4. Sigue llamando verbalmente desde la puerta o por altavoces.
5. Guarda las hojas — las necesitara el administrador cuando el sistema vuelva.

> Los estudiantes no pierden su lugar. Los numeros de voucher fisico son la referencia que manda.

---

## Cuando el sistema vuelve

### Si la caida fue breve (menos de 5 minutos)

Las pantallas volvern a mostrar el indicador verde **"En linea"** automaticamente.
El sistema se sincroniza solo — no necesitas hacer nada mas. Sigue desde donde estabas.

### Si la caida fue larga y se usaron hojas de papel

1. Recoge las hojas de todos los operadores.
2. Suma el ultimo numero atendido en manual.
3. Entra a **Admin → Lotes → Ajustar Contador**.
4. Ingresa el ultimo numero usado y el motivo (ej: *"Caida 11:00-12:30 — hojas en carpeta fisica 2026-10-12"*).
5. El sistema retomara desde el siguiente numero.
6. Archiva las hojas como respaldo del dia.

---

## Para el administrador — comandos rapidos

```bash
# Ver que esta corriendo
docker compose ps

# Reiniciar solo la aplicacion (sin tocar la base de datos)
docker compose restart app

# Ver que esta pasando en tiempo real
docker compose logs -f app

# Reiniciar todo
docker compose up -d

# Backup manual de la base de datos
bash scripts/backup.sh

# Restaurar desde un backup (hacer en equipo de prueba primero)
bash scripts/restore.sh backups/turnero-FECHA.sql.gz
```

---

## Arranque automatico del sistema

El sistema esta configurado para reiniciarse solo si el servidor se apaga y vuelve a encender.

**Windows:** Docker Desktop → Settings → "Start Docker Desktop when you log in"

**Linux:**
```bash
sudo systemctl enable docker
# El archivo docker-compose.yml ya tiene restart: unless-stopped en cada servicio
```

El orden de arranque es automatico: base de datos → Redis → pgBouncer → aplicacion.

---

## Respaldos automaticos

Para activar respaldos nocturnos en Linux, agrega esta linea al cron del servidor (`crontab -e`):

```
0 2 * * * /ruta/al/proyecto/scripts/backup.sh >> /var/log/turnero-backup.log 2>&1
```

Los archivos se guardan en `backups/` con retencion de los ultimos 7 dias.

---

*Version 1.1 · 2026-10-12*
