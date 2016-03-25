﻿import Promise = require("bluebird");
var fs = Promise.promisifyAll(require("fs"));
import crypto = require("crypto");
import common = require("../common");
var db = common.db;
import express = require("express");
import bodyParser = require("body-parser");
var postParser = bodyParser.json();
var router = express.Router();
var neo4j = require("neo4j");
import moment = require("moment");
var slug = require("slug");

interface User extends common.User { };
const timeFormat: string = "h:mm A";

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
		if (!name || !username) {
			response.json({ "success": false, "message": "Please enter both the user's name and username" });
			return;
		}
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
	})
	.delete(function (request, response) {
		var username = request.params.username;
		db.cypherAsync({
			query: "MATCH (user:User {username: {username}}) DELETE user",
			params: {
				username: username
			}
		}).then(function (results) {
			response.json({ "success": true, "message": "User deleted successfully" });
		}).catch(common.handleError.bind(response));
	});
router.route("/session")
	.get(function (request, response) {
		db.cypherAsync({
			query: `MATCH (s:Session) RETURN
				s.title AS title,
				s.slug AS slug,
				s.description AS description,
				s.type AS type,
				s.location AS location,
				s.capacity AS capacity,
				s.startTime AS startTime,
				s.endTime AS endTime
				ORDER BY s.startTime, s.title`
		}).then(function (results) {
			results = results.map(function (session) {
				return {
					"title": {
						"formatted": session.title,
						"slug": session.slug
					},
					"description": session.description,
					"type": session.type,
					"location": {
						"name": session.location,
						"capacity": session.capacity
					},
					"time": {
						"start": {
							"raw": session.startTime,
							"formatted": moment(session.startTime).format(timeFormat)
						},
						"end": {
							"raw": session.endTime,
							"formatted": moment(session.endTime).format(timeFormat)
						}
					}
				};
			});
			response.json(results);
		}).catch(common.handleError.bind(response));
	})
	.post(postParser, function (request, response) {
		var title = request.body.title;
		var description = request.body.description;
		var location = request.body.location;
		var capacity = request.body.capacity;
		var sessionType = request.body.type;
		var duration = request.body.duration;
		function isInteger (value: any): boolean {
			return typeof value === "number" &&
				isFinite(value) &&
				Math.floor(value) === value;
		}
		if (!title || !description || !location || !sessionType) {
			response.json({ "success": false, "message": "Please enter missing information" });
			return;
		}
		title = title.toString().trim();
		description = description.toString().trim();
		location = location.toString().trim();
		sessionType = sessionType.toString().trim();
		if (!title || !description || !location || !sessionType) {
			response.json({ "success": false, "message": "Please enter missing information" });
			return;
		}
		if (!isInteger(capacity) || capacity < 1) {
			response.json({ "success": false, "message": "Please enter a valid capacity" });
			return;
		}
		if (!isInteger(duration) || duration < 1) {
			response.json({ "success": false, "message": "Please enter a valid duration" });
			return;
		}
		common.getSymposiumDate()
			.then(function (date: moment.Moment) {
				var startTime = moment(request.body.startTime, timeFormat);
				startTime.set("year", date.get("year"));
				startTime.set("month", date.get("month"));
				startTime.set("date", date.get("date"));
				var endTime = startTime.clone().add(duration, "minutes");
				return db.cypherAsync({
					query: `CREATE (session:Session {
						title: { title },
						slug: { slug },
						description: { description },
						type: { type },
						location: { location },
						capacity: { capacity },
						startTime: { startTime },
						endTime: { endTime }
					})`,
					params: {
						title: title,
						slug: slug(title, { "lower": true }),
						description: description,
						location: location,
						capacity: capacity,
						type: sessionType,
						startTime: startTime.format(),
						endTime: endTime.format()
					}
				});
			})
			.then(function (results) {
				response.json({ "success": true, "message": "Session successfully created" });
			}).catch(neo4j.ClientError, function () {
				response.json({ "success": false, "message": "A session with that title already exists" });
			}).catch(common.handleError.bind(response));
	});
router.route("/session/:slug")
	.get(function (request, response) {
		var slug = request.params.slug;
		db.cypherAsync({
			query: `MATCH (s:Session {slug: {slug}}) RETURN
				s.title AS title,
				s.slug AS slug,
				s.description AS description,
				s.type AS type,
				s.location AS location,
				s.capacity AS capacity,
				s.startTime AS startTime,
				s.endTime AS endTime`,
			params: {
				slug: slug
			}
		}).then(function (results) {
			if (results.length == 0) {
				response.json(null);
			}
			else {
				response.json({
					"title": {
						"formatted": results[0].title,
						"slug": results[0].slug
					},
					"description": results[0].description,
					"type": results[0].type,
					"location": {
						"name": results[0].location,
						"capacity": results[0].capacity
					},
					"time": {
						"start": {
							"raw": results[0].startTime,
							"formatted": moment(results[0].startTime).format(timeFormat)
						},
						"end": {
							"raw": results[0].endTime,
							"formatted": moment(results[0].endTime).format(timeFormat)
						}
					}
				});
			}
		}).catch(common.handleError.bind(response));
	})
	.delete(function (request, response) {
		var slug = request.params.slug;
		db.cypherAsync({
			query: "MATCH (s:Session {slug: {slug}}) DELETE s",
			params: {
				slug: slug
			}
		}).then(function (results) {
			response.json({ "success": true, "message": "Session deleted successfully" });
		}).catch(common.handleError.bind(response));
	});
router.route("/schedule")
	.get(function (request, response) {
		db.cypherAsync({
			query: "MATCH (item:ScheduleItem) RETURN item.title AS title, item.time AS time, item.location AS location, item.editable AS editable"
		}).then(function (results) {
			response.json(results);
		}).catch(common.handleError.bind(response));
	});

export = router;