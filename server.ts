// Node.js libraries
import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as urllib from "url";
import * as path from "path";
// npm libraries
import * as common from "./common";
let keys = common.keys;
import * as moment from "moment";
const csv = require("csv");
import * as cheerio from "cheerio";
const git = require("git-last-commit");
// Set up the Express server
import * as express from "express";
import * as serveStatic from "serve-static";
import * as responseTime from "response-time";
import * as compress from "compression";
import * as cookieParser from "cookie-parser";
import * as bodyParser from "body-parser";

let app = express();
let postParser = bodyParser.urlencoded({ "extended": false });
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
import {dataRouter} from "./routes/data";
app.use("/data", dataRouter);
import {userRouter} from "./routes/user";
app.use("/user", userRouter);
import {registerRouter} from "./routes/register";
app.use("/register", registerRouter);
import {adminRouter} from "./routes/admin";
app.use("/admin", adminRouter);

app.route("/").get(async (request, response) => {
	response.send(await common.readFileAsync("pages/index.html"));
});
app.route("/about").get((request, response) => {
	Promise.all<string, string, any>([
		common.readFileAsync("pages/about.html"),
		common.readFileAsync("package.json")
			.then(JSON.parse)
			.then(data => data.version),
		new Promise<any>((resolve, reject) => {
			git.getLastCommit((err: Error | null, hash: any) => {
				if (err) {
					reject(err);
				}
				else {
					resolve(hash);
				}
			});
		})
	]).then(function ([aboutHTML, version, commit]) {
		// Dynamically update the version field to represent the current version from the package.json
		let $ = cheerio.load(aboutHTML);
		$("b#app-version").text(version + "@" + commit.shortHash);
		$("b#node-version").text(process.version);
		response.send($.html());
	}).catch(common.handleError.bind(response));
});
app.route("/print").get(async (request, response) => {
	response.send(await common.readFileAsync("pages/schedule.html"));
});

// 404 page
app.use(common.authenticateMiddleware, async (request, response, next) => {
	console.info(`Handled 404 for ${request.url} (${request.method}) by ${!!response.locals.user ? response.locals.user.username : "unauthenticated"} (${request.ip}) at ${new Date().toString()}`);
	//response.status(404).send("404 Not found!");
	let html = await common.readFileAsync("pages/404.html");
	let $ = cheerio.load(html);
	$("#url").text(request.url);
	response.status(404).send($.html());
});
// Generic error handling
app.use((err: Error, request: express.Request, response: express.Response, next: express.NextFunction) => {
	common.handleError.bind(response)(err);
});

const PORT = 8080;

// Set up the Socket.io server
let server = http.createServer(app).listen(PORT, "0.0.0.0", 511, () => {
	console.log("HTTP server listening on port " + PORT);
});

export = app;
