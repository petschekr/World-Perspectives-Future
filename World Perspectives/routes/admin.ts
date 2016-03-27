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
import moment = require("moment");
var slugMaker = require("slug");
var multer = require("multer");
var uploadHandler = multer({
	"storage": multer.memoryStorage(),
	"limits": {
		"fileSize": 1000000, // 1 MB
		"files": 1,
		"fields": 0
	},
	"fileFilter": function (request, file, callback) {
		const excelMimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
		if (file.mimetype === excelMimeType && !!file.originalname.match("\.xlsx$")) {
			callback(null, true);
		}
		else {
			callback(null, false);
		}
	}
});
var xlsx = require("node-xlsx");

interface User extends common.User { };
const timeFormat: string = "h:mm A";
function IgnoreError() {
    var temp = Error.apply(this, arguments);
    temp.name = this.name = "IgnoreError";
    this.stack = temp.stack;
    this.message = temp.message;
}
//inherit prototype using ECMAScript 5 (IE 9+)
IgnoreError.prototype = Object.create(Error.prototype, {
    constructor: {
        value: IgnoreError,
        writable: true,
        configurable: true
    }
});

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
		if (request.query.all && request.query.all.toLowerCase() === "true") {
			// All users' names for autocomplete
			db.cypherAsync({
				query: "MATCH (user:User) RETURN user.name AS name ORDER BY last(split(user.name, \" \"))"
			}).then(function (results) {
				response.json(results.map(function (user) {
					return user.name;
				}));
			}).catch(common.handleError.bind(response));
		}
		else {
			const usersPerPage = 10;
			var page = parseInt(request.query.page, 10);
			if (isNaN(page) || page < 0) {
				page = 0;
			}
			db.cypherAsync({
				queries: [{
					query: "MATCH (user:User) RETURN user.username AS username, user.name AS name, user.registered AS registered, user.admin AS admin, user.teacher AS teacher ORDER BY last(split(user.name, \" \")) SKIP {skip} LIMIT {limit}",
					params: {
						skip: page * usersPerPage,
						limit: usersPerPage
					}
				}, {
						query: "MATCH (user:User) RETURN count(user) AS total"
					}]
			}).then(function (results) {
				response.json({
					"info": {
						"page": page + 1,
						"pageSize": usersPerPage,
						"total": results[1][0].total,
						"totalPages": Math.ceil(results[1][0].total / usersPerPage)
					},
					"data": results[0]
				});
			}).catch(common.handleError.bind(response));
		}
	})
	.post(uploadHandler.single("import"), function (request, response) {
		try {
			// CAUTION: This is a blocking method
			var data = xlsx.parse(request.file.buffer);
		}
		catch (err) {
			response.json({ "success": false, "message": "Invalid Excel file uploaded" });
			return;
		}
		if (data.length !== 2) {
			response.json({ "success": false, "message": "Please put students on the first sheet and faculty on the second" });
			return;
		}
		var queries = [];
		var emailRegEx = /^(.*?)@gfacademy.org$/i;
		// Students
		for (let i = 0; i < data[0].data.length; i++) {
			let student = data[0].data[i];
			if (student.length === 0)
				continue;
			let firstName = student[0];
			let lastName = student[1];
			let email = student[2];
			let grade = parseInt(student[3], 10);
			if ((!firstName || !lastName || !email || isNaN(grade)) && i !== 0) {
				response.json({ "success": false, "message": "Invalid format for students. Expected first name, last name, email, grade." });
				return;
			}
			var emailParsed = email.match(emailRegEx);
			// Check if there is actually an email in the email field. If not, it's probably the header
			if (!emailParsed)
				continue;
			var code = crypto.randomBytes(16).toString("hex");
			queries.push({
				"query": "CREATE (user:User {name: {name}, username: {username}, registered: {registered}, teacher: {teacher}, admin: {admin}, code: {code}})",
				params: {
					name: `${firstName} ${lastName}`,
					username: emailParsed[1],
					registered: false,
					teacher: false,
					admin: false,
					code: code
				}
			});
		}
		// Faculty
		for (let i = 0; i < data[1].data.length; i++) {
			let teacher = data[1].data[i];
			if (teacher.length === 0)
				continue;
			let firstName = teacher[0];
			let lastName = teacher[1];
			let email = teacher[2];
			if (!firstName || !lastName || !email) {
				response.json({ "success": false, "message": "Invalid format for faculty. Expected first name, last name, email." });
				return;
			}
			var emailParsed = email.match(emailRegEx);
			// Check if there is actually an email in the email field. If not, it's probably the header
			if (!emailParsed)
				continue;
			var code = crypto.randomBytes(16).toString("hex");
			queries.push({
				"query": "CREATE (user:User {name: {name}, username: {username}, registered: {registered}, teacher: {teacher}, admin: {admin}, code: {code}})",
				params: {
					name: `${firstName} ${lastName}`,
					username: emailParsed[1],
					registered: false,
					teacher: true,
					admin: false,
					code: code
				}
			});
		}
		db.cypherAsync({ queries: queries })
			.then(function (results) {
				response.json({ "success": true, "message": `${queries.length} users successfully created` });
			}).catch(neo4j.ClientError, function () {
				response.json({ "success": false, "message": "A user with an existing username can't be imported. Rolling back changes." });
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
	.put(postParser, function (request, response) {
		// Generate a unique code for this user
		var code = crypto.randomBytes(16).toString("hex");
		var name = request.body.name;
		var username = request.params.username;
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
	})
	.delete(function (request, response) {
		var username = request.params.username;
		db.cypherAsync({
			query: "MATCH (user:User {username: {username}}) DETACH DELETE user",
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
				s.attendees AS attendees,
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
					"location": session.location,
					"capacity": {
						"total": session.capacity,
						"filled": session.attendees
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
		var slug = slugMaker(title, { "lower": true });
		var description = request.body.description;
		var location = request.body.location;
		var capacity = request.body.capacity;
		var sessionType = request.body.type;
		var duration = request.body.duration;
		var presenters = request.body.presenters;
		var moderator = request.body.moderator;
		function isInteger(value: any): boolean {
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
		if (moderator) {
			moderator = moderator.toString().trim();
		}
		if (!Array.isArray(presenters) || presenters.length < 1) {
			response.json({ "success": false, "message": "Please add a presenter" });
			return;
		}
		if (moderator && sessionType !== "Panel") {
			response.json({ "success": false, "message": "Only panels can have a moderator" });
			return;
		}
		if (sessionType !== "Panel" && presenters.length > 1) {
			response.json({ "success": false, "message": "Only one presenter is allowed per session" });
			return;
		}
		if (!moderator && sessionType === "Panel") {
			response.json({ "success": false, "message": "Panels must have a moderator" });
			return;
		}
		presenters = presenters.map(function (presenter) {
			return presenter.name;
		});
		var allUsers = (!moderator) ? presenters : presenters.concat(moderator);
		var tx;
		// Make sure that all presenters and moderators actually exist
		db.cypherAsync({
			query: "MATCH (u:User) WHERE u.name IN { names } RETURN count(u) AS users",
			params: {
				names: allUsers
			}
		}).then(function (results) {
			if (allUsers.length !== results[0].users) {
				if (sessionType !== "Panel") {
					response.json({ "success": false, "message": "The presenter could not be found" });
				}
				else {
					response.json({ "success": false, "message": "The moderator or one or more presenters could not be found" });
				}
				return Promise.reject(new IgnoreError());
			}

			return common.getSymposiumDate();
		}).then(function (date: moment.Moment) {
			var startTime = moment(request.body.startTime, timeFormat);
			startTime.set("year", date.get("year"));
			startTime.set("month", date.get("month"));
			startTime.set("date", date.get("date"));
			var endTime = startTime.clone().add(duration, "minutes");

			tx = Promise.promisifyAll(db.beginTransaction());
			return tx.cypherAsync({
				query: `CREATE (session:Session {
					title: { title },
					slug: { slug },
					description: { description },
					type: { type },
					location: { location },
					capacity: { capacity },
					attendees: { attendees },
					startTime: { startTime },
					endTime: { endTime }
				})`,
				params: {
					title: title,
					slug: slug,
					description: description,
					location: location,
					capacity: capacity,
					attendees: 0,
					type: sessionType,
					startTime: startTime.format(),
					endTime: endTime.format()
				}
			});
		}).then(function (results) {
			return Promise.mapSeries(presenters, function (presenter) {
				return tx.cypherAsync({
					query: `
							MATCH (user:User {name: { name }})
							MATCH (session:Session {slug: { slug }})
							CREATE (user)-[r:PRESENTS]->(session)`,
					params: {
						name: presenter,
						slug: slug
					}
				});
			}).then(function () {
				if (moderator) {
					return tx.cypherAsync({
						query: `
							MATCH (user:User {name: { name }})
							MATCH (session:Session {slug: { slug }})
							CREATE (user)-[r:MODERATES]->(session)`,
						params: {
							name: moderator,
							slug: slug
						}
					});
				}
				else {
					return Promise.resolve();
				}
			});
		}).then(function (results) {
			return tx.commitAsync();
		}).then(function (results) {
			console.log(5);
			response.json({ "success": true, "message": "Session successfully created" });
		}).catch(neo4j.ClientError, function (err) {
			console.log(err);
			response.json({ "success": false, "message": "A session with that title already exists" });
		}).catch(IgnoreError, function () {
			// Response has already been handled if this error is thrown
		}).catch(function (err) {
			if (tx) {
				tx.rollback(function () {
					common.handleError.bind(response)(err);
				});
			}
		});
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
				s.attendees AS attendees,
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
					"location": results[0].location,
					"capacity": {
						"total": results[0].capacity,
						"filled": results[0].attendees
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
			query: "MATCH (s:Session {slug: {slug}}) DETACH DELETE s",
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