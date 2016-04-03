import Promise = require("bluebird");
var fs = Promise.promisifyAll(require("fs"));
import common = require("../common");
var db = common.db;
var neo4j = require("neo4j");
import express = require("express");
import bodyParser = require("body-parser");
var postParser = bodyParser.json();
var router = express.Router();
import crypto = require("crypto");
var slugMaker = require("slug");
var sendgrid = Promise.promisifyAll(require("sendgrid")(common.keys.sendgrid));

interface User extends common.User { };

const timeFormat: string = "h:mm A";
const dateFormat: string = "MMMM Do, YYYY";

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
router.route("/signup")
	.get(function (request, response) {
		fs.readFileAsync("pages/signup.html", "utf8")
			.then(function (html: string) {
				response.send(html);
			})
			.catch(common.handleError.bind(response));
	})
	.post(postParser, function (request, response) {
		var code = crypto.randomBytes(16).toString("hex");
		var name = request.body.name;
		var email = request.body.email;
		var type = request.body.type;
		if (!name || !email || !type) {
			response.json({ "success": false, "message": "Please enter missing information" });
			return;
		}
		name = name.toString().trim();
		email = email.toString().trim();
		type = type.toString().trim();
		if (!name || !email || !type) {
			response.json({ "success": false, "message": "Please enter missing information" });
			return;
		}
		var username = slugMaker(name, { "lower": true });
		db.cypherAsync({
			query: "CREATE (user:User {name: {name}, username: {username}, email: {email}, registered: {registered}, type: {type}, admin: {admin}, code: {code}})",
			params: {
				name: name,
				username: username,
				email: email,
				registered: false,
				type: common.getUserType(type),
				admin: false,
				code: code
			}
		}).then(function (results) {
			// Set authentication cookie
			response.clearCookie("username");
			response.cookie("username", username, common.cookieOptions);
			// Get information on the event
			return common.getSymposiumDate();
		}).then(function (date: moment.Moment) {
			// Send them an email with their login link
			var emailToSend = new sendgrid.Email({
				to: email,
				from: "registration@wppsymposium.org",
				fromname: "GFA World Perspectives Symposium",
				subject: "Thank you for signing up!",
				text: 
`Hi ${name},

Thanks for signing up for the GFA World Perspectives Symposium on ${date.format(dateFormat)}! Be sure to register for symposium presentations soon before they fill up. If you are ever logged out, just click the following link to log in again:

https://wppsymposium.org/user/login/${code}

Feel free to reply to this email if you're having any problems.

Thanks,
The GFA World Perspectives Team
`
			});
			return sendgrid.sendAsync(emailToSend);
		}).then(function () {
			response.json({ "success": true, "message": "Account successfully created" });
		}).catch(neo4j.ClientError, function () {
			response.json({ "success": false, "message": "A user with that name or email already exists" });
		}).catch(common.handleError.bind(response));
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