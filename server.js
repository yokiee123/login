const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const { Pool } = require('pg');
const session = require('express-session');

const app = express();

// Use the dynamic port assigned by Heroku or default to 3000
const port = process.env.PORT || 3000;

// PostgreSQL pool configuration using Heroku's environment variable
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Middleware to parse URL-encoded bodies
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Set up session middleware
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key', // Use a secure secret key
    resave: false,
    saveUninitialized: false
}));

// Route to serve login page
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Handle login form submission
app.post('/login', (req, res) => {
    const { username, password } = req.body;

    if (username === 'admin' && password === 'admin') {
        req.session.loggedIn = true;
        res.redirect('/home.html');
    } else {
        res.send('<h1>Invalid credentials. Please <a href="/login">try again</a>.</h1>');
    }
});

// Middleware to protect routes
function checkAuth(req, res, next) {
    if (req.session.loggedIn) {
        next(); // User is authenticated, proceed to the next function
    } else {
        res.redirect('/login'); // User is not authenticated, redirect to login page
    }
}

// Protect the dashboard route
app.get('/home.html', checkAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

// Route to handle data submission and confirmation
app.post('/submit', checkAuth, async (req, res) => {
    try {
        const { barcodes, dates, components, volumes } = req.body;

        const barcodeArray = Array.isArray(barcodes) ? barcodes : [barcodes];
        const dateArray = Array.isArray(dates) ? dates : [dates];
        const componentArray = Array.isArray(components) ? components : [components];
        const volumeArray = Array.isArray(volumes) ? volumes : [volumes];

        for (let i = 0; i < barcodeArray.length; i++) {
            const barcodeID = barcodeArray[i];
            const dateCollection = dateArray[i];
            const volume = volumeArray[i];
            const component = componentArray[i];

            let table;
            if (component === 'PRBC') {
                table = 'PRBC';
            } else if (component === 'PC') {
                table = 'PC';
            } else if (component === 'PLASMA') {
                table = 'PLASMA';
            } else if (component === 'WB') {
                table = 'WB';
            } else if (component === 'CRYO') {
                table = 'CRYO';
            } else {
                continue; // Skip unknown components
            }

            const { rowCount } = await pool.query(
                `SELECT 1 FROM ${table} WHERE BARCODEID = $1`,
                [barcodeID]
            );

            if (rowCount === 0) {
                await pool.query(
                    `INSERT INTO ${table} (BARCODEID, Volume, DateCollection) VALUES ($1, $2, $3)`,
                    [barcodeID, volume, dateCollection]
                );
            }
        }

        // Redirect to confirmation page after submission
        res.redirect('/confirmation');
    } catch (error) {
        console.error('Error submitting data:', error);
        res.status(500).send('An error occurred while submitting data: ' + error.message + '<br><pre>' + error.stack + '</pre>');
    }
});

// Confirmation route
app.get('/confirmation', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>Confirmation</title>
                <style>
                    body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
                    h1 { color: green; }
                    a { text-decoration: none; color: darkred; }
                    a:hover { color: red; }
                </style>
            </head>
            <body>
                <h1>Data Submitted Successfully!</h1>
                <p>Your data has been successfully recorded.</p>
                <a href="/home.html">Go to Home</a>
            </body>
        </html>
    `);
});

// Route to handle barcode search for blood typing
app.post('/search', async (req, res) => {
    const { barcode } = req.body;

    try {
        const prbcResult = await pool.query(
            'SELECT * FROM prbc WHERE barcodeid = $1', [barcode]
        );

        const pcResult = await pool.query(
            'SELECT * FROM pc WHERE barcodeid = $1', [barcode]
        );

        const plasmaResult = await pool.query(
            'SELECT * FROM plasma WHERE barcodeid = $1', [barcode]
        );

        if (prbcResult.rows.length === 0 && pcResult.rows.length === 0 && plasmaResult.rows.length === 0) {
            return res.json({ error: 'No records found for this barcode.' });
        }

        res.json({
            prbc: prbcResult.rows[0] || null,
            pc: pcResult.rows[0] || null,
            plasma: plasmaResult.rows[0] || null
        });
    } catch (error) {
        console.error('Error searching barcode:', error);
        res.status(500).json({ error: 'Internal server error: ' + error.message });
    }
});

// Route to handle blood type submission for multiple tables
app.post('/addBloodType', async (req, res) => {
    const { barcode, bloodtype, rh } = req.body;

    try {
        const updatePRBC = 'UPDATE prbc SET bt = $1, rh = $2 WHERE barcodeid = $3';
        const prbcResult = await pool.query(updatePRBC, [bloodtype, rh, barcode]);

        const updatePC = 'UPDATE pc SET bt = $1, rh = $2 WHERE barcodeid = $3';
        const pcResult = await pool.query(updatePC, [bloodtype, rh, barcode]);

        const updatePLASMA = 'UPDATE plasma SET bt = $1, rh = $2 WHERE barcodeid = $3';
        const plasmaResult = await pool.query(updatePLASMA, [bloodtype, rh, barcode]);

        if (prbcResult.rowCount > 0 || pcResult.rowCount > 0 || plasmaResult.rowCount > 0) {
            res.json({ success: true, message: 'Blood type and Rh type updated successfully in all tables.' });
        } else {
            res.json({ success: false, message: 'No rows updated. Barcode not found.' });
        }
    } catch (error) {
        console.error('Error updating blood type:', error);
        res.status(500).json({ error: 'Internal server error: ' + error.message });
    }
});

// Function to update screening results in a table
const updateScreeningResults = async (tableName, barcodeid, hcv, syphilis, hbsag, hiv, malaria) => {
    const query = `
        UPDATE ${tableName}
        SET HCV = $1, Syphilis = $2, HBsAg = $3, HIV = $4, Malaria = $5
        WHERE barcodeid = $6;
    `;
    await pool.query(query, [hcv, syphilis, hbsag, hiv, malaria, barcodeid]);
};

// Handle screening form submission
app.post('/submitScreening', async (req, res) => {
    const { barcode, hcv, syphilis, hbsag, hiv, malaria } = req.body;

    try {
        await updateScreeningResults('prbc', barcode, hcv, syphilis, hbsag, hiv, malaria);
        await updateScreeningResults('pc', barcode, hcv, syphilis, hbsag, hiv, malaria);
        await updateScreeningResults('plasma', barcode, hcv, syphilis, hbsag, hiv, malaria);

        res.redirect('/screening.html');
    } catch (error) {
        console.error('Error updating screening results:', error);
        res.status(500).send('Internal server error: ' + error.message);
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
