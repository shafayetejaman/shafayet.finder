import QtQuick
import qs.Commons
import qs.Ui
import "script/Core.js" as Core
import "script/Fuzzy.js" as Fuzzy
import "script/FdQuery.js" as FdQuery
import "script/Walks.js" as Walks
import "script/Search.js" as Search
import "script/Settings.js" as Settings
import "script/Preview.js" as Preview

Rectangle {
  id: rowRoot

  required property int index
  required property string name
  required property string dir

  property bool hasCursor: false
  property string home: ""
  property string fontFamily: Style.font.menuFamily
  property int nameSize: 13
  property int captionSize: 12
  property int rowHeight: 58

  signal hoverMoved(int idx, Item item, var mouse)
  signal activated(int idx)

  width: ListView.view.width
  height: rowRoot.rowHeight
  radius: Style.cornerRadius
  color: rowRoot.hasCursor ? Color.menu.selectedBackground : "transparent"

  Column {
    anchors.fill: parent
    anchors.leftMargin: Style.space(12)
    anchors.rightMargin: Style.space(12)
    anchors.topMargin: Style.space(8)
    anchors.bottomMargin: Style.space(8)
    spacing: 0

    Text {
      width: parent.width
      text: rowRoot.name
      textFormat: Text.PlainText
      color: rowRoot.hasCursor ? Color.menu.selectedText : Color.menu.text
      font.family: rowRoot.fontFamily
      font.pixelSize: rowRoot.nameSize
      elide: Text.ElideRight
    }

    Text {
      width: parent.width
      text: Core.shortenPath(rowRoot.dir, rowRoot.home)
      textFormat: Text.PlainText
      color: rowRoot.hasCursor ? Color.menu.selectedText : Color.menu.text
      opacity: 0.55
      font.family: rowRoot.fontFamily
      font.pixelSize: rowRoot.captionSize
      elide: Text.ElideMiddle
    }
  }

  MouseArea {
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onPositionChanged: function(mouse) {
      rowRoot.hoverMoved(rowRoot.index, rowRoot, mouse)
    }
    onClicked: rowRoot.activated(rowRoot.index)
  }
}
