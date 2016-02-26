import Promise = require("bluebird");
var fs = Promise.promisifyAll(require("fs"));
import crypto = require("crypto");
import common = require("../common");
var db = common.db;
import express = require("express");
import bodyParser = require("body-parser");
var postParser = bodyParser.json();
var router = express.Router();
var neo4j = require("neo4j");

interface User extends common.User { };

var authenticateCheck = common.authenticateMiddleware;
var adminCheck = function (request: express.Request, response: express.Response, next: express.NextFunction): void {
	if (!response.locals.authenticated || !response.locals.user.admin) {
		response.redirect("/");
	}
	else {
		next();
	}
};
router.use(authenticateCheck, adminCheck);

router.route("/").get(function (request, response) {
    fs.readFileAsync("pages/admin.html", "utf8")
		.then(function (html: string) {
			response.send(html);
		})
		.catch(common.handleError.bind(response));
});

router.route("/user")
	.get(function (request, response) {
		const usersPerPage = 10;
		db.cypherAsync({
			query: "MATCH (user:User) RETURN user.username AS username, user.name AS name, user.registered AS registered, user.admin AS admin, user.teacher AS teacher ORDER BY last(split(user.name, \" \")) SKIP {skip} LIMIT {limit}",
			params: {
				skip: request.query.page * usersPerPage,
				limit: usersPerPage
			}
		}).then(function (results) {
			response.json(results);
		}).catch(common.handleError.bind(response));
	})
	.post(postParser, function (request, response) {
		// Generate a unique code for this user
		var code = crypto.randomBytes(16).toString("hex");
		var name = request.body.name;
		var username = request.body.username;
		var isTeacher = !!request.body.teacher;
		var isAdmin = !!request.body.admin;
		db.cypherAsync({
			query: "CREATE (user:User {name: {name}, username: {username}, registered: {registered}, teacher: {teacher}, admin: {admin}, code: {code}})",
			params: {
				name: name,
				username: username,
				registered: false,
				teacher: isTeacher,
				admin: isAdmin,
				code: code
			}
		}).then(function (results) {
			console.log(results);
			response.json({ "success": true, "message": "User successfully created" });
		}).catch(neo4j.ClientError, function () {
			response.json({ "success": false, "message": "A user with that username already exists" });
		}).catch(common.handleError.bind(response));
	});
router.route("/user/:username")
	.get(function (request, response) {
		var username = request.params.username;
		db.cypherAsync({
			query: "MATCH (user:User {username: {username}}) RETURN user.username AS username, user.name AS name, user.registered AS registered, user.admin AS admin, user.teacher AS teacher",
			params: {
				username: username
			}
		}).then(function (results) {
			if (results.length == 0) {
				results = null;
			}
			else {
				results = results[0];
			}
			response.json(results);
		}).catch(common.handleError.bind(response));
	});

export = router;