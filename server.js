const app = require('./api/index');
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`🚀 PayCoinADS Backend running on port ${PORT}`);
});
