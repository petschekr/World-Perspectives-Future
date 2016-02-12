var fs = require("fs");
var http = require("http");
// npm libraries
var keys = JSON.parse(fs.readFileSync("keys.json").toString("utf8"));
var csv = require("csv");
var Q = require("kew"); // Because the Orchestrate driver for Node.js forces its use
var db = require("orchestrate")(keys.orchestrate);
var pusher = require("pushbullet");
pusher = new pusher(keys.pushbullet);
var SendGrid = require("sendgrid");
var sendgrid = SendGrid(keys.sendgrid.username, keys.sendgrid.password);
// Test database connection
db.ping()
    .then(function () {
    console.log("Successfully connected to Orchestrate");
})
    .fail(function () {
    console.error("Failed to connect to Orchestrate");
    process.exit(1);
});
// Set up the Express server
var express = require("express");
var serveStatic = require("serve-static");
var responseTime = require("response-time");
var compress = require("compression");
var cookieParser = require("cookie-parser");
var bodyParser = require("body-parser");
var app = express();
var postParser = bodyParser.urlencoded({ "extended": false });
app.use(compress());
app.use(responseTime());
var cookieOptions = {
    "path": "/",
    "maxAge": 1000 * 60 * 60 * 24 * 30 * 6,
    "secure": false,
    "httpOnly": true,
    "signed": true
};
app.use(cookieParser(keys.cookieSecret, // Secret for signing cookies
cookieOptions));
app.use("/bower_components", serveStatic("bower_components"));
app.use("/components", serveStatic("public/components"));
app.use("/css", serveStatic("public/css"));
app.use("/img", serveStatic("public/img"));
function CancelError(message) {
    this.message = message;
}
CancelError.prototype = Object.create(Error.prototype);
function handleError(error) {
    console.error(error.stack);
    // Notify via PushBullet
    pusher.note({}, "WPP Error", new Date().toString() + "\n\n" + error.stack, function () { });
}
app.route("/").get(function (request, response) {
    fs.readFile("pages/index.html", "utf8", function (err, html) {
        response.send(html);
    });
});
// 404 page
app.use(function (request, response, next) {
    response.status(404).send("404 Not found!");
});
// Error handling
app.use(function (err, request, response, next) {
    handleError(err);
    response.status(500);
    response.send("An internal server error occurred.");
});
var PORT = 8080;
// Set up the Socket.io server
var server = http.createServer(app).listen(PORT, "0.0.0.0", 511, function () {
    console.log("HTTP server listening on port " + PORT);
});
var io = require("socket.io").listen(server);
/*
app.get('/', routes.index);
app.get('/users', user.list);
*/ 
//# sourceMappingURL=server.js.map