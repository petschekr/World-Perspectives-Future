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
var sendgrid = Promise.promisifyAll(require("sendgrid")(common.keys.sendgrid));
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
const dateFormat: string = "MMMM Do, YYYY";
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
		if (request.method === "GET") {
			response.redirect("/");
		}
		else {
			response.status(403).send("Forbidden to non-admin users");
		}
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
			var filter = request.query.filter;
			if (!filter)
				filter = "all";
			if (filter === "all") {
				var criteria = "";
			}
			else if (filter === "admin") {
				var criteria = "admin: true";
			}
			else if (filter === "nonadmin") {
				var criteria = "admin: false";
			}
			else {
				var criteria = "type: {type}";
			}
			db.cypherAsync({
				queries: [{
					query: `MATCH (user:User {${criteria}}) RETURN user.username AS username, user.name AS name, user.email AS email, user.registered AS registered, user.admin AS admin, user.type AS type, user.code AS code ORDER BY last(split(user.name, " ")) SKIP {skip} LIMIT {limit}`,
					params: {
						skip: page * usersPerPage,
						limit: usersPerPage,
						type: common.getUserType(filter)
					}
				}, {
					query: `MATCH (user:User {${criteria}}) RETURN count(user) AS total`,
					params: {
						type: common.getUserType(filter)
					}
				}]
			}).then(function (results) {
				response.json({
					"info": {
						"page": page + 1,
						"pageSize": usersPerPage,
						"total": results[1][0].total,
						"totalPages": Math.ceil(results[1][0].total / usersPerPage)
					},
					"data": results[0].map(function (user) {
						if (!user.email) {
							user.email = `${user.username}@gfacademy.org`
						}
						return user;
					})
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
				"query": "CREATE (user:User {name: {name}, username: {username}, registered: {registered}, type: {type}, admin: {admin}, code: {code}})",
				params: {
					name: `${firstName} ${lastName}`,
					username: emailParsed[1],
					registered: false,
					type: common.UserType.Student,
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
				"query": "CREATE (user:User {name: {name}, username: {username}, registered: {registered}, type: {type}, admin: {admin}, code: {code}})",
				params: {
					name: `${firstName} ${lastName}`,
					username: emailParsed[1],
					registered: false,
					type: common.UserType.Teacher,
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
	})
	.delete(function (request, response) {
		db.cypherAsync({
			query: "MATCH (user:User {admin: false}) DETACH DELETE user"
		}).then(function (results) {
			response.json({ "success": true, "message": "All non-admin users successfully deleted" });
		}).catch(common.handleError.bind(response));
	});
router.route("/user/:username")
	.get(function (request, response) {
		var username = request.params.username;
		db.cypherAsync({
			query: "MATCH (user:User {username: {username}}) RETURN user.username AS username, user.name AS name, user.email AS email, user.registered AS registered, user.admin AS admin, user.type AS type, user.code AS code",
			params: {
				username: username
			}
		}).then(function (results) {
			if (results.length == 0) {
				results = null;
			}
			else {
				results = results[0];
				if (!results.email) {
					results.email = `${results.username}@gfacademy.org`
				}
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
		name = name.toString().trim();
		username = username.toString().toLowerCase().trim();
		if (!name || !username) {
			response.json({ "success": false, "message": "Please enter both the user's name and username" });
			return;
		}
		var isTeacher = !!request.body.teacher;
		var isAdmin = !!request.body.admin;
		db.cypherAsync({
			query: "CREATE (user:User {name: {name}, username: {username}, registered: {registered}, type: {type}, admin: {admin}, code: {code}})",
			params: {
				name: name,
				username: username,
				registered: false,
				type: isTeacher ? common.UserType.Teacher : common.UserType.Student,
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
				ORDER BY s.startTime, lower(s.title)`
		}).then(function (results) {
			return Promise.map(results, function (session: any) {
				return db.cypherAsync({
					queries: [{
						query: "MATCH (user:User)-[r:PRESENTS]->(s:Session {slug: { slug }}) RETURN user.username AS username, user.name AS name ORDER BY last(split(user.name, \" \"))",
						params: {
							slug: session.slug
						}
					}, {
						query: "MATCH (user:User)-[r:MODERATES]->(s:Session {slug: { slug }}) RETURN user.username AS username, user.name AS name",
						params: {
							slug: session.slug
						}
					}]
				}).then(function (sessionRelationships) {
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
							},
							"date": moment(session.startTime).format(dateFormat)
						},
						"presenters": sessionRelationships[0],
						"moderator": (sessionRelationships[1].length !== 0) ? sessionRelationships[1][0] : null
					};
				});
			});
		})
		.then(function (sessions) {
			response.json(sessions);
		})
		.catch(common.handleError.bind(response));
	})
	.post(postParser, function (request, response) {
		var title = request.body.title;
		var slug = slugMaker(title, { "lower": true });
		var description = request.body.description;
		var location = request.body.location;
		var capacity = request.body.capacity;
		var sessionType = request.body.type;
		var periodID = request.body.periodID;
		var presenters = request.body.presenters;
		var moderator = request.body.moderator;
		function isInteger(value: any): boolean {
			return typeof value === "number" &&
				isFinite(value) &&
				Math.floor(value) === value;
		}
		if (!title || !description || !location || !sessionType || !periodID) {
			response.json({ "success": false, "message": "Please enter missing information" });
			return;
		}
		title = title.toString().trim();
		description = description.toString().trim();
		location = location.toString().trim();
		sessionType = sessionType.toString().trim();
		periodID = periodID.toString().trim();
		if (!title || !description || !location || !sessionType) {
			response.json({ "success": false, "message": "Please enter missing information" });
			return;
		}
		if (!isInteger(capacity) || capacity < 1) {
			response.json({ "success": false, "message": "Please enter a valid capacity" });
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

			return db.cypherAsync({
				query: "MATCH (item:ScheduleItem {id: {id}, editable: true}) RETURN item.id AS id, item.start AS start, item.end AS end",
				params: {
					id: periodID
				}
			});
		}).then(function (period) {
			if (period.length !== 1) {
				response.json({ "success": false, "message": "A customizable period with that ID could not be found" });
				return Promise.reject(new IgnoreError());
			}

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
					startTime: period[0].start,
					endTime: period[0].end
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
			queries: [{
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
			}, {
				query: "MATCH (user:User)-[r:PRESENTS]->(s:Session {slug: {slug}}) RETURN user.username AS username, user.name AS name ORDER BY last(split(user.name, \" \"))",
				params: {
					slug: slug
				}
			}, {
				query: "MATCH (user:User)-[r:MODERATES]->(s:Session {slug: {slug}}) RETURN user.username AS username, user.name AS name",
				params: {
					slug: slug
				}
			}]
		}).then(function (results) {
			var sessions = results[0];
			if (sessions.length == 0) {
				response.json(null);
			}
			else {
				response.json({
					"title": {
						"formatted": sessions[0].title,
						"slug": sessions[0].slug
					},
					"description": sessions[0].description,
					"type": sessions[0].type,
					"location": sessions[0].location,
					"capacity": {
						"total": sessions[0].capacity,
						"filled": sessions[0].attendees
					},
					"time": {
						"start": {
							"raw": sessions[0].startTime,
							"formatted": moment(sessions[0].startTime).format(timeFormat)
						},
						"end": {
							"raw": sessions[0].endTime,
							"formatted": moment(sessions[0].endTime).format(timeFormat)
						},
						"date": moment(sessions[0].startTime).format(dateFormat)
					},
					"presenters": results[1],
					"moderator": (results[2].length !== 0) ? results[2][0] : null
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
			query: "MATCH (item:ScheduleItem) RETURN item.id AS id, item.title AS title, item.start AS start, item.end AS end, item.location AS location, item.editable AS editable ORDER BY item.start"
		}).then(function (results) {
			response.json(results.map(function (item) {
				var startTime = item.start;
				delete item.start;
				var endTime = item.end;
				delete item.end;
				item.time = {
					"start": {
						"raw": startTime,
						"formatted": moment(startTime).format(timeFormat)
					},
					"end": {
						"raw": endTime,
						"formatted": moment(endTime).format(timeFormat)
					}
				};
				return item;
			}));
		}).catch(common.handleError.bind(response));
	})
	.patch(postParser, function (request, response) {
		function isInteger(value: any): boolean {
			return typeof value === "number" &&
				isFinite(value) &&
				Math.floor(value) === value;
		}
		var { id, title, startTime, duration, location, customizable }: { id: string, title: string, startTime: string, duration: number, location: string, customizable: boolean } = request.body;
		if (!id) {
			response.json({ "success": false, "message": "Missing ID" });
			return;
		}
		if (!title || !startTime || !duration || typeof customizable !== "boolean") {
			response.json({ "success": false, "message": "Please enter missing information" });
			return;
		}
		title = title.toString().trim();
		startTime = startTime.toString().trim();
		if (location) {
			location = location.toString().trim();
		}
		else {
			location = null;
		}
		if (!isInteger(duration) || duration < 1) {
			response.json({ "success": false, "message": "Please enter a valid duration" });
			return;
		}
		common.getSymposiumDate().then(function (date: moment.Moment) {
			var start = moment(startTime, timeFormat);
			start.set("year", date.get("year"));
			start.set("month", date.get("month"));
			start.set("date", date.get("date"));
			var end = start.clone().add(duration, "minutes");

			if (!start.isValid() || !end.isValid()) {
				response.json({ "success": false, "message": "Invalid start time or duration" });
				return Promise.reject(new IgnoreError());
			}

			return db.cypherAsync({
				query: "MATCH (item:ScheduleItem {id: {id}}) SET item.title = {title}, item.start = {startTime}, item.end = {endTime}, item.location = {location}, item.editable = {customizable}",
				params: {
					id: id,
					title: title,
					startTime: start.format(),
					endTime: end.format(),
					location: location,
					customizable: customizable
				}
			});
		}).catch(IgnoreError, function () {
			// Response has already been handled if this error is thrown
		}).then(function (results) {
			response.json({ "success": true, "message": "Updated successfully" });
		}).catch(common.handleError.bind(response));
	});
router.route("/schedule/switch").patch(postParser, function (request, response) {
	var {id1, id2}: { id1: string, id2: string } = request.body;
	if (!id1 || !id2) {
		response.json({ "success": false, "message": "Missing IDs" });
		return;
	}
	Promise.map([id1, id2], function (id) {
		return db.cypherAsync({
			query: "MATCH (item:ScheduleItem {id: {id}}) RETURN item.id AS id, item.start AS start, item.end AS end",
			params: {
				id: id
			}
		});
	}).spread(function (item1, item2) {
		/*if (item1.length !== 1 || !item2.length !== 1) {

		}*/
	});
});
router.route("/schedule/date")
	.get(function (request, response) {
		common.getSymposiumDate().then(function (date: moment.Moment) {
			response.json({
				"formatted": date.format("MMMM Do, YYYY")
			});
		}).catch(common.handleError.bind(response));
	})
	.patch(postParser, function (request, response) {
		var rawDate: string = request.body.date;
		if (!rawDate) {
			response.json({ "success": false, "message": "No date input" });
			return;
		}
		rawDate = rawDate.toString().trim();
		if (!rawDate) {
			response.json({ "success": false, "message": "No date input" });
			return;
		}
		var date: moment.Moment = moment(rawDate, dateFormat);
		if (!date.isValid()) {
			response.json({ "success": false, "message": "Invalid date input" });
			return;
		}

		// Get all schedule items and sessions
		db.cypherAsync({
			queries: [{
				query: "MATCH (item:ScheduleItem) RETURN item.id AS id, item.start AS start, item.end AS end"
			}, {
				query: "MATCH (s:Session) RETURN s.slug AS slug, s.startTime AS start, s.endTime AS end"
			}]
		}).spread(function (scheduleItems: any[], sessions: any[]) {
			scheduleItems.map(function (item) {
				var start = moment(item.start);
				var end = moment(item.end);
				start.set("year", date.get("year"));
				start.set("month", date.get("month"));
				start.set("date", date.get("date"));
				end.set("year", date.get("year"));
				end.set("month", date.get("month"));
				end.set("date", date.get("date"));
				item.start = start;
				item.end = end;
				return item;
			});
			sessions.map(function (session) {
				var start = moment(session.start);
				var end = moment(session.end);
				start.set("year", date.get("year"));
				start.set("month", date.get("month"));
				start.set("date", date.get("date"));
				end.set("year", date.get("year"));
				end.set("month", date.get("month"));
				end.set("date", date.get("date"));
				session.start = start.format();
				session.end = end.format();
				return session;
			});
			var queries: any[] = [{
				query: "MATCH (c:Constant) WHERE c.date IS NOT NULL SET c.date = { date } RETURN c",
				params: {
					date: date.format("YYYY-MM-DD")
				}
			}];
			queries = queries.concat(scheduleItems.map(function (item) {
				return {
					query: "MATCH (item:ScheduleItem {id: {id}}) SET item.start = {start}, item.end = {end}",
					params: {
						id: item.id,
						start: item.start,
						end: item.end
					}
				};
			}));
			queries = queries.concat(sessions.map(function (session) {
				return {
					query: "MATCH (s:Session {slug: {slug}}) SET s.startTime = {start}, s.endTime = {end}",
					params: {
						slug: session.slug,
						start: session.start,
						end: session.end
					}
				};
			}));
			return db.cypherAsync({
				queries: queries
			});
		}).then(function (results) {
			response.json({ "success": true, "message": "Symposium date changed successfully" });
		}).catch(common.handleError.bind(response));
	});
router.route("/registration/email")
	.get(function (request, response) {
		db.cypherAsync({
			query: "MATCH (c:Constant) WHERE c.registrationEmailTime IS NOT NULL RETURN c"
		}).then(function (result) {
			var registrationEmailTime: boolean = result[0].c.properties.registrationEmailTime;
			response.json({
				"raw": registrationEmailTime,
				"formatted": `${moment(registrationEmailTime).format(dateFormat)} at ${moment(registrationEmailTime).format(timeFormat)}`
			});
		}).catch(common.handleError.bind(response));
	})
	.post(function (request, response) {
		var totalRecipients = 0;
		// Get emails to send to
		Promise.all([
			db.cypherAsync({
				"query": "MATCH (u:User) RETURN u.name AS name, u.username AS username, u.email AS email, u.code AS code"
			}),
			common.getSymposiumDate()
		]).spread(function (results, date: moment.Moment) {
			totalRecipients = results.length;
			return Promise.mapSeries(results, function (user: any) {
				var email = (!!user.email) ? user.email : `${user.username}@gfacademy.org`;
				var emailToSend = new sendgrid.Email({
					to: email,
					from: "registration@wppsymposium.org",
					fromname: "GFA World Perspectives Symposium",
					subject: "GFA WPP Symposium Registration",
					text:
					`Hi ${user.name},

This year's World Perspectives Symposium will take place on ${date.format(dateFormat)}. To login and register for presentations, visit the following link:

https://wppsymposium.org/user/login/${user.code}

Be sure to register for presentations soon before they fill up. You can visit the link at any time after you've registered to view your schedule. If you miss the registration cut-off date, your schedule will be automatically generated based on availability.

Feel free to reply to this email if you're having any problems.

Thanks,
The GFA World Perspectives Team
`
				});
				return sendgrid.sendAsync(emailToSend);
			});
		}).then(function (results) {
			return db.cypherAsync({
				query: "MATCH (c:Constant) WHERE c.registrationEmailTime IS NOT NULL SET c.registrationEmailTime = {time} RETURN c",
				params: {
					time: moment().format()
				}
			});
		}).then(function (results) {
			response.json({ "success": true, "message": `Sent registration emails to ${totalRecipients} recipients` });
		}).catch(common.handleError.bind(response));
	});
router.route("/registration/open")
	.get(function(request, response) {
		db.cypherAsync({
			query: "MATCH (c:Constant) WHERE c.registrationOpen IS NOT NULL RETURN c"
		}).then(function (result) {
			var registrationOpen: boolean = result[0].c.properties.registrationOpen;
			response.json({
				"open": registrationOpen
			});
		}).catch(common.handleError.bind(response));
	})
	.put(postParser, function (request, response) {
		var {open}: { open: boolean } = request.body;
		if (typeof open !== "boolean") {
			response.json({ "success": false, "message": "Invalid open value" });
			return;
		}
		db.cypherAsync({
			query: "MATCH (c:Constant) WHERE c.registrationOpen IS NOT NULL SET c.registrationOpen = {open} RETURN c",
			params: {
				open: open
			}
		}).then(function (result) {
			response.json({ "success": true, "message": `Registration is now ${open ? "open" : "closed"}` });
		}).catch(common.handleError.bind(response));
	});

export = router;