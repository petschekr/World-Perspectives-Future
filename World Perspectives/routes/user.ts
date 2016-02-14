import common = require("../common");
var db = common.db;
import express = require("express");
var router = express.Router();

interface User {
	"code": String;
	"name": String;
	"username": String;
	"registered": Boolean;
	"admin": Boolean;
}

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

export = router;
