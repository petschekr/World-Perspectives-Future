import fs = require("fs");
import express = require("express");
import Promise = require("bluebird");
var neo4j = require("neo4j");

export interface User {
	"code": String;
	"name": String;
	"username": String;
	"registered": Boolean;
	"admin": Boolean;
}
export var keys: {
	"orchestrate": string;
	"neo4j": {
		"username": string;
		"password": string;
		"server": string;
	};
	"pushbullet": string;
	"sendgrid": {
		"username": string;
		"password": string;
	};
	"cookieSecret": string;
} = JSON.parse(fs.readFileSync("keys.json").toString("utf8"));
export var cookieOptions = {
	"path": "/",
	"maxAge": 1000 * 60 * 60 * 24 * 30 * 6, // 6 months
	"secure": false,
	"httpOnly": true,
	"signed": true
};

var dbRaw = new neo4j.GraphDatabase(`http://${keys.neo4j.username}:${keys.neo4j.password}@${keys.neo4j.server}:7474`);
export var db = Promise.promisifyAll(dbRaw);
export var authenticateMiddleware = function (request: express.Request, response: express.Response, next: express.NextFunction): void {
	var username = request.signedCookies.username || "";
	db.cypherAsync({
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

var pusher = require("pushbullet");
pusher = Promise.promisifyAll(new pusher(keys.pushbullet));
// Enumerate active devices to push to in case of an error
var pushbulletDevices: string[] = [];
pusher.devicesAsync()
	.then(function (response) {
		var devices: any[] = response.devices;
		for (let device of devices) {
			if (device.active) {
				pushbulletDevices.push(device.iden);
			}
		}
	})
	.catch(function (err: Error) {
		throw err;
	});
export var handleError = function (err: any): void {
	console.error(err.stack);

	// Check if this error occurred while responding to a request
	if (this.status && this.send) {
		var response: express.Response = this;
		response.status(500);
		response.send("An internal server error occurred.");
	}

	const debugging: boolean = true;
	if (debugging) {
		return;
	}
	// Notify via PushBullet
	var pushbulletPromises: any[] = [];
	for (let deviceIden of pushbulletDevices) {
		pushbulletPromises.push(pusher.noteAsync(deviceIden, "WPP Error", `${new Date().toString()}\n\n${err.stack}`));
	}
	Promise.all(pushbulletPromises).then(function () {
		console.log("Error report sent via Pushbullet");
	}).catch(function (err: Error) {
		console.error("Error encountered while sending error report via Pushbullet");
		console.error(err);
	});
};