import Promise = require("bluebird");
// Node.js libraries
import crypto = require("crypto");
var fs = Promise.promisifyAll(require("fs"));
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
import cheerio = require("cheerio");
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
import registerRouter = require("./routes/register");
import adminRouter = require("./routes/admin");
app.use("/data", dataRouter);
app.use("/user", userRouter);
app.use("/register", registerRouter);
app.use("/admin", adminRouter);

app.route("/").get(function (request, response) {
	fs.readFileAsync("pages/index.html", "utf8")
		.then(function (html: string) {
			response.send(html);
		})
		.catch(common.handleError.bind(response));
});
app.route("/about").get(function (request, response) {
	Promise.all([
		fs.readFileAsync("pages/about.html", "utf8"),
		fs.readFileAsync("package.json", "utf8")
			.then(JSON.parse)
			.get("version")
	]).then(function ([aboutHTML, version]) {
		// Dynamically update the version field to represent the current version from the package.json
		var $ = cheerio.load(aboutHTML);
		$("b#app-version").text(version);
		$("b#node-version").text(process.version);
		response.send($.html());
	}).catch(common.handleError.bind(response));
});
app.route("/print").get(function (request, response) {
	fs.readFileAsync("pages/schedule.html", "utf8")
		.then(function (html: string) {
			response.send(html);
		})
		.catch(common.handleError.bind(response));
});

// 404 page
app.use(common.authenticateMiddleware, function (request, response, next) {
	console.info(`Handled 404 for ${request.url} (${request.method}) by ${!!response.locals.user ? response.locals.user.username : "unauthenticated"} (${request.ip}) at ${new Date().toString()}`);
	//response.status(404).send("404 Not found!");
	fs.readFileAsync("pages/404.html", "utf8")
		.then(function (html: string) {
			var $ = cheerio.load(html);
			$("#url").text(request.url);
			response.status(404).send($.html());
		})
		.catch(common.handleError.bind(response));
});
// Generic error handling
app.use(function (err: Error, request, response, next) {
	common.handleError.bind(response)(err);
});

const PORT = 8080;

// Set up the Socket.io server
var server = http.createServer(app).listen(PORT, "0.0.0.0", 511, function () {
	console.log("HTTP server listening on port " + PORT);
});
var io = require("socket.io").listen(server);
common.io = io;

export = app;