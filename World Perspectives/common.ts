import fs = require("fs");
import express = require("express");
import Promise = require("bluebird");
var neo4j = require("neo4j");

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
	}).catch(function (err: Error) {
		next(err);
	});
};