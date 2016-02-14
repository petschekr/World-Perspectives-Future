// Node.js libraries
import crypto = require("crypto");
import fs = require("fs");
import http = require("http");
import https = require("https");
import urllib = require("url");
import path = require("path");
// npm libraries
import common = require("./common");
var keys = common.keys;
var db = common.db;
import moment = require("moment");
var csv = require("csv");
var pusher = require("pushbullet");
pusher = new pusher(keys.pushbullet);
import SendGrid = require("sendgrid");
var sendgrid = SendGrid(keys.sendgrid.username, keys.sendgrid.password);
// Set up the Express server
import express = require("express");
import serveStatic = require("serve-static");
import responseTime = require("response-time");
import compress = require("compression");
import cookieParser = require("cookie-parser");
import bodyParser = require("body-parser");
// Routes
import dataRouter = require("./routes/data");

var app = express();
var postParser = bodyParser.urlencoded({ "extended": false });
app.use(compress());
app.use(responseTime());
var cookieOptions = {
	"path": "/",
	"maxAge": 1000 * 60 * 60 * 24 * 30 * 6, // 6 months
	"secure": false,
	"httpOnly": true,
	"signed": true
};
app.use(cookieParser(
	keys.cookieSecret, // Secret for signing cookies
	cookieOptions
));

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
	pusher.note({}, "WPP Error", `${new Date().toString()}\n\n${error.stack}`, function () { });
}

app.route("/").get(function (request, response): void {
	fs.readFile("pages/index.html", "utf8", function (err, html) {
		response.send(html);
	});
});
app.use("/data", dataRouter);


// 404 page
app.use(function (request, response, next) {
	response.status(404).send("404 Not found!");
});
// Error handling
app.use(function (err: Error, request, response, next) {
	handleError(err);
	response.status(500);
	response.send("An internal server error occurred.");
});

const PORT = 8080;

// Set up the Socket.io server
var server = http.createServer(app).listen(PORT, "0.0.0.0", 511, function (): void {
	console.log("HTTP server listening on port " + PORT);
});
var io = require("socket.io").listen(server);

/*
app.get('/', routes.index);
app.get('/users', user.list);
*/