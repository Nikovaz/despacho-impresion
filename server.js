require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '25mb' }));

// Servir archivos estáticos del dashboard
app.use(express.static(__dirname));

const ORDERS_FILE = path.join(__dirname, 'orders.json');

// Función auxiliar para leer pedidos
function getOrders() {
    try {
        if (!fs.existsSync(ORDERS_FILE)) {
            fs.writeFileSync(ORDERS_FILE, JSON.stringify([]));
            return [];
        }
        const data = fs.readFileSync(ORDERS_FILE, 'utf8');
        return JSON.parse(data || '[]');
    } catch (e) {
        console.error('Error reading orders file:', e);
        return [];
    }
}

// Función auxiliar para guardar pedidos
function saveOrders(orders) {
    try {
        fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2), 'utf8');
    } catch (e) {
        console.error('Error saving orders file:', e);
    }
}

// Endpoint para recibir pedidos desde n8n (Webhook)
app.post('/api/orders', (req, res) => {
    try {
        const orderData = req.body;
        if (!orderData || !orderData.Cliente) {
            return res.status(400).json({ error: 'Formato de pedido inválido' });
        }

        const orders = getOrders();
        const newOrder = {
            id: orderData.externalId || `ORDER-${Date.now()}`,
            cliente_nombre: orderData.Cliente.Nombre || 'Cliente',
            cliente_whatsapp: orderData.Cliente.Nombre_Whatsapp || orderData.Cliente.Nombre || '',
            celular: orderData.Cliente.Celular || '',
            direccion: orderData.Direccion || (orderData.Envio ? 'Dirección a confirmar' : 'Retiro en depósito Once'),
            envio: orderData.Envio !== false,
            metodo_pago: orderData.Metodo_Pago || 'Efectivo / Transferencia',
            detalles: orderData.Detalles || [],
            total: orderData.Total || 0,
            fecha_hora: new Date().toISOString(),
            estado: 'pendiente',
            raw_payload: orderData
        };

        // Si ya existe un pedido con el mismo ID, lo actualizamos; si no, lo agregamos al principio
        const existingIndex = orders.findIndex(o => o.id === newOrder.id);
        if (existingIndex >= 0) {
            orders[existingIndex] = { ...orders[existingIndex], ...newOrder };
        } else {
            orders.unshift(newOrder);
        }

        saveOrders(orders);
        console.log(`✅ [PEDIDO RECIBIDO] ID: ${newOrder.id} | Cliente: ${newOrder.cliente_nombre} | Total: $${newOrder.total}`);
        res.json({ ok: true, message: 'Pedido registrado con éxito', order: newOrder });
    } catch (error) {
        console.error('Error procesando pedido:', error);
        res.status(500).json({ error: 'Error interno al guardar pedido', details: error.message });
    }
});

// Endpoint para listar pedidos
app.get('/api/orders', (req, res) => {
    try {
        const orders = getOrders();
        res.json(orders);
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener pedidos' });
    }
});

// Endpoint para cambiar estado de pedido (ej: marcar como impreso)
app.put('/api/orders/:id/status', (req, res) => {
    try {
        const { id } = req.params;
        const { estado } = req.body;
        const orders = getOrders();
        const order = orders.find(o => o.id === id);
        if (!order) {
            return res.status(404).json({ error: 'Pedido no encontrado' });
        }
        order.estado = estado;
        saveOrders(orders);
        res.json({ ok: true, order });
    } catch (error) {
        res.status(500).json({ error: 'Error al actualizar estado' });
    }
});

// Endpoint para listar en vivo los archivos de una carpeta pública de Google Drive (Autopublicador)
app.get('/api/drive-folder/:folderId', async (req, res) => {
    try {
        const { folderId } = req.params;
        if (!folderId || !/^[a-zA-Z0-9_-]{15,60}$/.test(folderId)) {
            return res.status(400).json({ error: 'folderId inválido' });
        }
        const driveUrl = `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}#list`;
        const response = await fetch(driveUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        if (!response.ok) {
            return res.status(response.status).json({ error: `Drive responded ${response.status}` });
        }
        const html = await response.text();
        const files = [];
        const regex = /id="entry-([a-zA-Z0-9_-]+)"[\s\S]*?<div class="flip-entry-title">([^<]+)<\/div>/g;
        let m;
        while ((m = regex.exec(html)) !== null) {
            const id = m[1];
            const name = m[2].trim();
            if (!/\d/.test(name) && !/\.(jpg|jpeg|png|webp|mp4|mov)$/i.test(name)) continue;
            files.push({ id, name });
        }
        res.json({ ok: true, folderId, count: files.length, files });
    } catch (error) {
        console.error('Error listando carpeta de Google Drive:', error);
        res.status(500).json({ error: 'No se pudo leer la carpeta de Drive', details: error.message });
    }
});

// Endpoint de proxy seguro para la API de DeepSeek
app.post('/api/analyze-lead', async (req, res) => {
    try {
        const { messages, response_format } = req.body;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'Messages array is required' });
        }

        const apiKey = process.env.DEEPSEEK_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'DeepSeek API Key is not configured on the server' });
        }

        // Llamada segura a DeepSeek desde el backend (servidor-a-servidor)
        const response = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'deepseek-chat',
                messages,
                response_format: response_format || { type: 'json_object' }
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`DeepSeek API error: ${response.status} - ${errorText}`);
            return res.status(response.status).json({ 
                error: `DeepSeek API returned error: ${response.status}`, 
                details: errorText 
            });
        }

        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('Error in proxy endpoint:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`============================================================`);
    console.log(`🚀 Totodrilo IA CRM Dashboard running at: http://localhost:${PORT}`);
    console.log(`🖨️ Panel de Impresión: http://localhost:${PORT}/imprimir.html`);
    console.log(`📥 Webhook Receptor de Pedidos: http://localhost:${PORT}/api/orders`);
    console.log(`============================================================`);
});
