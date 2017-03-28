import * as http from "http";
import * as https from "https";
import * as fs from "fs";
import * as express from "express";
import * as moment from "moment";
import * as neo4j from "neo4j";
import * as socket from "socket.io";

export function readFileAsync (filename: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		fs.readFile(filename, "utf8", (err, data) => {
			if (err) {
				reject(err);
				return;
			}
			resolve(data);
		})
	});
}

export enum UserType {
	Student,
	Teacher,
	Parent,
	Alum,
	Visitor,
	Other
};
export var getUserType = function (userTypeString: string): UserType {
	switch (userTypeString.toLowerCase().trim()) {
		case "student":
			return UserType.Student;
		case "teacher":
		case "faculty":
			return UserType.Teacher;
		case "parent":
			return UserType.Parent;
		case "alum":
		case "alumnus / alumna":
			return UserType.Alum;
		case "visitor":
		case "guest":
			return UserType.Visitor;
		default:
			return UserType.Other;
	}
};

export interface User {
	"code": String;
	"name": String;
	"username": String;
	"registered": Boolean;
	"admin": Boolean;
	"type": UserType;
}
export const keys: {
	"neo4j": {
		"username": string;
		"password": string;
		"server": string;
	};
	"pushbullet": string;
	"sendgrid": string;
	"cookieSecret": string;
} = JSON.parse(fs.readFileSync("keys.json").toString("utf8"));
export const cookieOptions = {
	"path": "/",
	"maxAge": 1000 * 60 * 60 * 24 * 30 * 6, // 6 months
	"secure": false,
	"httpOnly": true,
	"signed": true
};
export let io: any = null;
export function connectWS(server: http.Server | https.Server) {
	io = socket.listen(server);
}

let dbRaw = new neo4j.GraphDatabase(`http://${keys.neo4j.username}:${keys.neo4j.password}@${keys.neo4j.server}:7474`);
export function cypherAsync (options: neo4j.CypherOptions): Promise<any> {
	return new Promise<any>((resolve, reject) => {
		dbRaw.cypher(options, (err, result) => {
			if (err) {
				reject(err);
				return;
			}
			resolve(result);
		});
	});
}
export var authenticateMiddleware = function (request: express.Request, response: express.Response, next: express.NextFunction): void {
	var username = request.signedCookies.username || "";
	cypherAsync({
		query: "MATCH (user:User {username: {username}}) RETURN user",
		params: {
			username: username
		}
	}).then(function (results) {
		var user = null;
		var loggedIn: boolean;
		if (results.length < 1) {
			// Username not found in database
			loggedIn = false;
		}
		else {
			user = results[0].user.properties;
			user.admin = !!user.admin; // Could be true or null
			loggedIn = true;
		}
		response.locals.authenticated = loggedIn;
		response.locals.user = user;
		next();
	}).catch(handleError.bind(response));
};

export var getSymposiumDate = function (): Promise<moment.Moment> {
	return cypherAsync({
		query: "MATCH (c:Constant) WHERE c.date IS NOT NULL RETURN c"
	}).then(function (results) {
		return moment(results[0].c.properties.date);
	});
};


const Pusher = require("pushbullet");
let pusher = new Pusher(keys.pushbullet);
// Enumerate active devices to push to in case of an error
var pushbulletDevices: string[] = [];
pusher.devices((err: Error | null, response: any) => {
	if (err) throw err;
	
	let devices: any[] = response.devices;
	pushbulletDevices = devices.filter(device => device.active).map(device => device.iden);
});
export var handleError = function (err: any): void {
	console.error(err.stack);

	// Check if this error occurred while responding to a request
	if (this.status && this.send) {
		var response: express.Response = this;
		fs.readFile("pages/500.html", "utf8", function (err, html) {
			response.status(500);
			if (err) {
				console.error(err);
				response.send("An internal server error occurred and an additional error occurred while serving an error page.");
				return;
			}
			response.send(html);
		});
	}

	const debugging: boolean = true;
	if (debugging) {
		return;
	}
	// Notify via PushBullet
	var pushbulletPromises: any[] = [];
	for (let deviceIden of pushbulletDevices) {
		//pushbulletPromises.push(pusher.noteAsync(deviceIden, "WPP Error", `${new Date().toString()}\n\n${err.stack}`));
	}
	Promise.all(pushbulletPromises).then(function () {
		console.log("Error report sent via Pushbullet");
	}).catch(function (err: Error) {
		console.error("Error encountered while sending error report via Pushbullet");
		console.error(err);
	});
};
