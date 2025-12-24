import http from 'http';

const token = "eFhGsW33pNeOFaDFs8u0PC:APA91bF70DZQ7b0D0paGdp42xVelIOYNKKXjTmWaGDhOrpAq-04JmuMDaSe-TEqeJsIxH0jydpLKy5pnf6ZNlXGAh1pAalH1nqv6Lut0bwQfPvFBMsnQmTI";

console.log("⏳ Tienes 5 segundos para minimizar la app o cambiar de pestaña...");
setTimeout(() => {
    runTest();
}, 5000);

function runTest() {
    console.log("🚀 Enviando notificación ahora...");

    const data = JSON.stringify({
        fcmToken: token,
        title: "Prueba Definitiva",
        body: "¡Si lees esto, todo funciona perfecto! 🎉"
    });

    const options = {
        hostname: 'localhost',
        port: 3000,
        path: '/api/test-notification',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data)
        }
    };

    const req = http.request(options, (res) => {
        let responseData = '';

        res.on('data', (chunk) => {
            responseData += chunk;
        });

        res.on('end', () => {
            console.log('Status Code:', res.statusCode);
            console.log('Response:', responseData);
        });
    });

    req.on('error', (error) => {
        console.error('Error conectando al backend:', error);
    });

    req.write(data);
    req.end();
}