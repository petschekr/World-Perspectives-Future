import Promise = require("bluebird");
var fs = Promise.promisifyAll(require("fs"));
import common = require("../common");
var db = common.db;
import express = require("express");
var router = express.Router();

interface User extends common.User { };

router.route("/").get(common.authenticateMiddleware, function (request, response) {
    if (response.locals.authenticated) {
		let user: User = response.locals.user;
		response.json({
			"name": user.name,
			"username": user.username,
			"registered": user.registered,
			"admin": user.admin
		});
	}
	else {
		response.status(403).json({
			"error": "Invalid identification cookie"
		});
		return;
	}
});
router.route("/signup").get(function (request, response) {
	fs.readFileAsync("pages/signup.html", "utf8")
		.then(function (html: string) {
			response.send(html);
		})
		.catch(common.handleError.bind(response));
});
router.route("/login/:code").get(function (request, response) {
	response.clearCookie("username");
	var code = request.params.code.toString();
	// Check if the provided code is valid
	db.cypherAsync({
		query: "MATCH (user:User {code: {code}}) RETURN user",
		params: {
			code: code
		}
	}).then(function (results) {
		if (results.length !== 1) {
			// Invalid code
			fs.readFile("pages/invalidcode.html", "utf8", function (err: Error, html: string) {
				if (err) {
					return common.handleError(err);
				}
				response.send(html);
			});
			return;
		}
		var user: User = results[0].user.properties;
		// Set a cookie to identify this user later
		response.cookie("username", user.username, common.cookieOptions);
		// Direct request by whether or not the user has already registered
		if (user.registered) {
			response.redirect("/");
		}
		else {
			response.redirect("/register");
		}
	}).catch(common.handleError.bind(response));
});

export = router;