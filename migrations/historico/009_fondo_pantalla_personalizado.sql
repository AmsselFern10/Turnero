-- Migración 009: Fondo de pantalla institucional personalizado
INSERT INTO configuracion (clave, valor, descripcion)
VALUES 
    (
        'fondo_imagen_url',
        '',
        'URL o ruta de la imagen institucional de fondo para pantallas (Kiosko, TV, Operador, Login)'
    ),
    (
        'fondo_imagen_activa',
        'false',
        'Activar o desactivar la imagen de fondo institucional en las pantallas del sistema'
    )
ON CONFLICT (clave) DO NOTHING;
