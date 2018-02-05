import * as crypto from "crypto";
import * as common from "../common";
import * as neo4j from "neo4j";
import * as express from "express";
import * as bodyParser from "body-parser";
import * as slugMaker from "slug";
import * as sendgrid from "@sendgrid/mail";

let postParser = bodyParser.json();
export let userRouter = express.Router();

sendgrid.setApiKey(common.keys.sendgrid);

type User = common.User;

//const timeFormat: string = "h:mm A";
const dateFormat: string = "MMMM Do, YYYY";

userRouter.route("/").get(common.authenticateMiddleware, (request, response) => {
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
userRouter.route("/signup")
	.get(async (request, response) => {
		response.send(await common.readFileAsync("pages/signup.html"));
	})
	.post(postParser, async (request, response) => {
		let code = crypto.randomBytes(16).toString("hex");
		let name = request.body.name;
		let email = request.body.email;
		let type = request.body.type;
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
		let username = slugMaker(name, { "lower": true });
		try {
			await common.cypherAsync({
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
			});
			// Set authentication cookie
			response.clearCookie("username");
			response.cookie("username", username, common.cookieOptions);
			// Get information on the event
			let date = await common.getSymposiumDate();
			// Send them an email with their login link
			let emailToSend = {
				to: { name, email },
				from: {
					name: "GFA World Perspectives Symposium",
					email: "registration@wppsymposium.org"
				},
				subject: "Thank you for signing up!",
				text: 
`Hi ${name},

Thanks for signing up for the GFA World Perspectives Symposium on ${date.format(dateFormat)}! Be sure to register for symposium presentations soon before they fill up. If you are ever logged out, just click the following link to log in again:

https://wppsymposium.org/user/login/${code}

Feel free to reply to this email if you're having any problems.

Thanks,
The GFA World Perspectives Team
`
			};
			await sendgrid.send(emailToSend);
			response.json({ "success": true, "message": "Account successfully created" });
		}
		catch (err) {
			if (err instanceof neo4j.ClientError) {
				response.json({ "success": false, "message": "A user with that name or email already exists" });
				return;
			}
			common.handleError(response, err);
		}
	});
userRouter.route("/login/:code").get(async (request, response) => {
	response.clearCookie("username");
	let code = request.params.code.toString();
	// Check if the provided code is valid
	try {
		let results = await common.cypherAsync({
			query: "MATCH (user:User {code: {code}}) RETURN user",
			params: {
				code: code
			}
		});
		if (results.length !== 1) {
			// Invalid code
			response.send(await common.readFileAsync("pages/invalidcode.html"));
			return;
		}
		let user: User = results[0].user.properties;
		// Set a cookie to identify this user later
		response.cookie("username", user.username, common.cookieOptions);
		// Direct request by whether or not the user has already registered
		if (user.registered) {
			response.redirect("/");
		}
		else {
			response.redirect("/register");
		}
	}
	catch (err) {
		common.handleError(response, err);
	}
});
