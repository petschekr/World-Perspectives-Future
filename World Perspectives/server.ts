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
import SendGrid = require("sendgrid");
var sendgrid = SendGrid(keys.sendgrid.username, keys.sendgrid.password);
// Set up the Express server
import express = require("express");
import serveStatic = require("serve-static");
import responseTime = require("response-time");
import compress = require("compression");
import cookieParser = require("cookie-parser");
import bodyParser = require("body-parser");

var app = express();
var postParser = bodyParser.urlencoded({ "extended": false });
app.use(compress());
app.use(responseTime());
app.use(cookieParser(
	keys.cookieSecret, // Secret for signing cookies
	common.cookieOptions
));

app.use("/bower_components", serveStatic("bower_components"));
app.use("/components", serveStatic("public/components"));
app.use("/css", serveStatic("public/css"));
app.use("/img", serveStatic("public/img"));

// Routes
import dataRouter = require("./routes/data");
import userRouter = require("./routes/user");
app.use("/data", dataRouter);
app.use("/user", userRouter);

app.route("/").get(function (request, response) {
	fs.readFile("pages/index.html", "utf8", function (err, html) {
		if (err) {
			return common.handleError(err);
		}
		response.send(html);
	});
});


// 404 page
app.use(function (request, response, next) {
	console.info(`Handled 404 for ${request.url}`);
	response.status(404).send("404 Not found!");
});
// Error handling
app.use(function (err: Error, request, response, next) {
	common.handleError(err);
	response.status(500);
	response.send("An internal server error occurred.");
});

const PORT = 8080;

// Set up the Socket.io server
var server = http.createServer(app).listen(PORT, "0.0.0.0", 511, function () {
	console.log("HTTP server listening on port " + PORT);
});
var io = require("socket.io").listen(server);