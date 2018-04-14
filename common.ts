import * as fs from "fs";
import * as express from "express";
import * as moment from "moment";
import { v1 as neo4j } from "neo4j-driver";
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

export interface RawUser {
	code: string;
	name: string;
	username: string;
	registered: boolean;
	admin: boolean;
	grade: neo4j.Integer;
	type: neo4j.Integer;
}

export const keys: {
	production: boolean;
	neo4j: {
		username: string;
		password: string;
		server: string;
	};
	pushbullet: string;
	sendgrid: string;
	cookieSecret: string;
} = JSON.parse(fs.readFileSync("keys.json").toString("utf8"));
export const cookieOptions = {
	"path": "/",
	"maxAge": 1000 * 60 * 60 * 24 * 30 * 6, // 6 months
	"secure": keys.production,
	"httpOnly": true,
	"signed": true
};
export let io: any = null;
export function connectWS(server: any) {
	io = socket.listen(server);
}

export const driver = neo4j.driver(`bolt://${keys.neo4j.server}`, neo4j.auth.basic(
	keys.neo4j.username,
	keys.neo4j.password
));

export var authenticateMiddleware = function (request: express.Request, response: express.Response, next: express.NextFunction): void {
	var username = request.signedCookies.username || "";

	const dbSession = driver.session();
	dbSession
		.run("MATCH (user:User {username: {username}}) RETURN user", { username })
		.then(function (result) {
			let user: RawUser | null = null;
			let loggedIn: boolean;
			if (result.records.length < 1) {
				// Username not found in database
				loggedIn = false;
			}
			else {
				user = result.records[0].get("user").properties as RawUser;
				user.admin = !!user.admin; // Could be true or null
				loggedIn = true;
			}
			response.locals.authenticated = loggedIn;
			response.locals.user = user;
			dbSession.close();
			next();
		})
		.catch(handleError.bind(response));
};

export async function getSymposiumDate(): Promise<moment.Moment> {
	const dbSession = driver.session();
	let result = await dbSession.run("MATCH (c:Constant) WHERE c.date IS NOT NULL RETURN c");
	dbSession.close();
	return moment(result.records[0].get("c").properties.date);
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
export var handleError = function (response: express.Response, err: any): void {
	console.error(err.stack);

	fs.readFile("pages/500.html", "utf8", function (err, html) {
		response.status(500);
		if (err) {
			console.error(err);
			response.send("An internal server error occurred and an additional error occurred while serving an error page.");
			return;
		}
		response.send(html);
	});

	if (!keys.production) {
		return;
	}
	// Notify via PushBullet
	var pushbulletPromises: Promise<void>[] = [];
	for (let deviceIden of pushbulletDevices) {
		pushbulletPromises.push(new Promise<void>((resolve, reject) => {
			pusher.note(deviceIden, "WPP Error", `${new Date().toString()}\n\n${err.stack}`, (err: Error) => {
				if (err) {
					reject(err);
				}
				else {
					resolve();
				}
			});
		}));
	}
	Promise.all(pushbulletPromises).then(function () {
		console.log("Error report sent via Pushbullet");
	}).catch(function (err: Error) {
		console.error("Error encountered while sending error report via Pushbullet");
		console.error(err);
	});
};
